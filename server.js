// ╔══════════════════════════════════════════════════════════════════╗
// ║  PR MODULE — Express + MySQL2 Backend                           ║
// ║  Database: p2p_process                                          ║
// ║                                                                  ║
// ║  Setup:                                                          ║
// ║    npm init -y                                                   ║
// ║    npm install express mysql2 cors dotenv multer uuid            ║
// ║    node server.js                                                ║
// ╚══════════════════════════════════════════════════════════════════╝

require("dotenv").config();
const express   = require("express");
const mysql     = require("mysql2/promise");
const cors      = require("cors");
const multer    = require("multer");
const { v4: uuidv4 } = require("uuid");
const path      = require("path");
const fs        = require("fs");

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Middleware ────────────────────────────────────────────────
const allowedOrigins = (process.env.FRONTEND_URLS || process.env.FRONTEND_URL || "http://localhost:5173,http://localhost:5174")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error("Not allowed by CORS"));
  }
}));
app.use(express.json());
// Serve uploaded files


// ── File upload (multer) ──────────────────────────────────────
const UPLOAD_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Serve uploaded files statically
app.use("/uploads", (req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  next();
}, express.static(UPLOAD_DIR));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),

  filename: (req, file, cb) => cb(null, `${uuidv4()}_${file.originalname}`),
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB

// ── MySQL Connection Pool ─────────────────────────────────────
const pool = mysql.createPool({
  host:     process.env.DB_HOST     || "localhost",
  port:     process.env.DB_PORT     || 3306,
  user:     process.env.DB_USER     || "root",
  password: process.env.DB_PASS     || "",
  database: process.env.DB_NAME     || "p2p_process",
  waitForConnections: true,
  connectionLimit:    10,
  timezone: "+00:00",
});

// Test connection on startup
pool.getConnection()
  .then(conn => { console.log("✅ MySQL connected to p2p_process"); conn.release(); })
  .catch(err  => console.error("❌ MySQL connection failed:", err.message));

// ── Helper: map DB row → JS camelCase object ──────────────────
function mapHeader(row) {
  if (!row) return null;
  return {
    id:              row.id,
    prNumber:        row.pr_number,
    prDate:          row.pr_date?.toISOString?.().slice(0,10) ?? row.pr_date,
    status:          row.status,
    mrqNumber:       row.mrq_number       ?? "",
    locationCode:    row.location_code    ?? "",
    locationName:    row.location_name    ?? "",
    remarks:         row.remarks          ?? "",
    originatorCode:  row.originator_code  ?? "",
    originatorName:  row.originator_name  ?? "",
    requestor:       row.requestor        ?? "",
    purchaser:       row.purchaser        ?? "",
    jobNumber:       row.job_number       ?? "",
    jobBrief:        row.job_brief        ?? "",
    subJobBrief:     row.sub_job_brief    ?? "",
    vessel:          row.vessel           ?? "",
    shipManager:     row.ship_manager     ?? "",
    co:              row.co               ?? "",
    reasonCode:      row.reason_code      ?? "",
    brand:           row.brand            ?? "",
    supplier:        row.supplier         ?? "",
    supplierSite:    row.supplier_site    ?? "",
    contactPerson:   row.contact_person   ?? "",
    buyer:           row.buyer            ?? "",
    rfqRequired:     !!row.rfq_required,
    reservePo:       row.reserve_po       ?? "Optional",
    operatingUnit:   row.operating_unit   ?? "",
    budgetCode:      row.budget_code      ?? "",
    costCenter:      row.cost_center      ?? "",
    deliveryDate:    row.delivery_date?.toISOString?.().slice(0,10) ?? row.delivery_date ?? "",
    shippingMethod:  row.shipping_method  ?? "Sea Freight",
    priority:        row.priority         ?? "Normal",
    approvedOn:      row.approved_on      ?? null,
    confirmedOn:     row.confirmed_on     ?? null,
    rejectedOn:      row.rejected_on      ?? null,
    approvedBy:      row.approved_by      ?? null,
    confirmedBy:     row.confirmed_by     ?? null,
    rejectedBy:      row.rejected_by      ?? null,
    createdBy:       row.created_by       ?? "",
    createdAt:       row.created_at       ?? null,
  };
}

function mapLine(row) {
  return {
    id:          row.id,
    lineNumber:  row.line_number,
    jobNo:       row.job_number   ?? "",
    subJob:      row.sub_job      ?? "1",
    itemCode:    row.item_code    ?? "",
    description: row.description  ?? "",
    remarks:     row.remarks      ?? "",
    uom:         row.uom          ?? "PC",
    quantity:    parseFloat(row.quantity)   || 0,
    unitPrice:   parseFloat(row.unit_price) || 0,
  };
}

// ── Helper: write audit log ───────────────────────────────────
async function auditLog(conn, prHeaderId, action, oldStatus, newStatus, changedBy, notes = "") {
  await conn.execute(
    `INSERT INTO xxits_pr_audit_log (id, pr_header_id, action, old_status, new_status, changed_by, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [uuidv4(), prHeaderId, action, oldStatus, newStatus, changedBy, notes]
  );
}

// ════════════════════════════════════════════════════════════════
// GET /api/pr  — search / list
// Query params: prNo, status, vessel, supplier, dateFrom, dateTo
// ════════════════════════════════════════════════════════════════
app.get("/api/pr", async (req, res) => {
  try {
    const { prNo, status, vessel, supplier, dateFrom, dateTo } = req.query;

    let sql = `
      SELECT
        h.id, h.pr_number, h.pr_date, h.status, h.vessel, h.supplier,
        h.location_name, h.priority, h.created_by, h.created_at,
        COUNT(l.id)                         AS total_lines,
        COALESCE(SUM(l.quantity), 0)        AS total_qty,
        COALESCE(SUM(l.quantity * l.unit_price), 0) AS total_amount
      FROM xxits_pr_headers h
      LEFT JOIN xxits_pr_lines l ON l.pr_header_id = h.id
      WHERE 1=1
    `;
    const params = [];

    if (prNo)     { sql += " AND h.pr_number LIKE ?";   params.push(`%${prNo}%`); }
    if (status)   { sql += " AND h.status = ?";          params.push(status); }
    if (vessel)   { sql += " AND h.vessel LIKE ?";       params.push(`%${vessel}%`); }
    if (supplier) { sql += " AND h.supplier LIKE ?";     params.push(`%${supplier}%`); }
    if (dateFrom) { sql += " AND h.pr_date >= ?";        params.push(dateFrom); }
    if (dateTo)   { sql += " AND h.pr_date <= ?";        params.push(dateTo); }

    sql += " GROUP BY h.id ORDER BY h.created_at DESC";

    const [rows] = await pool.execute(sql, params);

    const result = rows.map(r => ({
      id:           r.id,
      prNumber:     r.pr_number,
      prDate:       r.pr_date?.toISOString?.().slice(0,10) ?? r.pr_date,
      status:       r.status,
      vessel:       r.vessel       ?? "",
      supplier:     r.supplier     ?? "",
      locationName: r.location_name ?? "",
      priority:     r.priority     ?? "Normal",
      totalLines:   Number(r.total_lines),
      totalQty:     Number(r.total_qty),
      totalAmount:  Number(r.total_amount),
      createdBy:    r.created_by   ?? "",
      createdAt:    r.created_at   ?? null,
    }));

    res.json(result);
  } catch (err) {
    console.error("GET /api/pr error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
// GET /api/pr/:id  — fetch single PR with lines + attachments
// ════════════════════════════════════════════════════════════════
app.get("/api/pr/:id", async (req, res) => {
  try {
    const [[headerRow]] = await pool.execute(
      "SELECT * FROM xxits_pr_headers WHERE id = ?", [req.params.id]
    );
    if (!headerRow) return res.status(404).json({ error: "PR not found" });

    const [lineRows] = await pool.execute(
      "SELECT * FROM xxits_pr_lines WHERE pr_header_id = ? ORDER BY line_number",
      [req.params.id]
    );
    const [attachRows] = await pool.execute(
      "SELECT * FROM xxits_pr_attachments WHERE pr_header_id = ? ORDER BY uploaded_at",
      [req.params.id]
    );

    const header = mapHeader(headerRow);
    header.lines       = lineRows.map(mapLine);
    header.attachments = attachRows.map(a => ({
      id:         a.id,
      name:       a.file_name,
      type:       a.file_type,
      size:       (a.file_size_kb || 0) * 1024,
      storagePath:a.storage_path,
      uploadedAt: a.uploaded_at,
      uploadedBy: a.uploaded_by,
    }));

    res.json(header);
  } catch (err) {
    console.error("GET /api/pr/:id error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
// POST /api/pr  — create new PR
// Body: { ...header fields, lines: [...] }
// ════════════════════════════════════════════════════════════════
app.post("/api/pr", async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const h  = req.body;
    const id = uuidv4();

    await conn.execute(`
      INSERT INTO xxits_pr_headers (
        id, pr_number, pr_date, status,
        mrq_number, location_code, location_name, remarks,
        originator_code, originator_name, requestor, purchaser,
        job_number, job_brief, sub_job_brief,
        vessel, ship_manager, co, reason_code, brand,
        supplier, supplier_site, contact_person, buyer,
        rfq_required, reserve_po, operating_unit,
        budget_code, cost_center,
        delivery_date, shipping_method, priority,
        created_by
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        h.prNumber, h.prDate, "Draft",
        h.mrqNumber||null, h.locationCode||null, h.locationName||null, h.remarks||null,
        h.originatorCode||null, h.originatorName||null, h.requestor||null, h.purchaser||null,
        h.jobNumber||null, h.jobBrief||null, h.subJobBrief||null,
        h.vessel||null, h.shipManager||null, h.co||null, h.reasonCode||null, h.brand||null,
        h.supplier||null, h.supplierSite||null, h.contactPerson||null, h.buyer||null,
        h.rfqRequired ? 1 : 0, h.reservePo||"Optional", h.operatingUnit||null,
        h.budgetCode||null, h.costCenter||null,
        h.deliveryDate||null, h.shippingMethod||"Sea Freight", h.priority||"Normal",
        h.createdBy||"SYSTEM",
      ]
    );

    // Insert lines
    const lines = h.lines || [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      await conn.execute(`
        INSERT INTO xxits_pr_lines
          (id, pr_header_id, line_number, job_number, sub_job, item_code, description, remarks, uom, quantity, unit_price)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [uuidv4(), id, i+1, l.jobNo||null, l.subJob||"1", l.itemCode||null, l.description||null, l.remarks||null, l.uom||"PC", l.quantity||0, l.unitPrice||0]
      );
    }

    await auditLog(conn, id, "CREATE", null, "Draft", h.createdBy||"SYSTEM", "PR created");
    await conn.commit();

    // Return the created PR
    const [[created]] = await pool.execute("SELECT * FROM xxits_pr_headers WHERE id=?", [id]);
    res.status(201).json(mapHeader(created));
  } catch (err) {
    await conn.rollback();
    console.error("POST /api/pr error:", err);
    if (err.code === "ER_DUP_ENTRY") return res.status(409).json({ error: "PR number already exists" });
    res.status(500).json({ error: err.message });
  } finally { conn.release(); }
});

// ════════════════════════════════════════════════════════════════
// PUT /api/pr/:id  — update PR header + replace all lines
// ════════════════════════════════════════════════════════════════
app.put("/api/pr/:id", async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const h = req.body;

    // Check PR exists and is editable
    const [[existing]] = await conn.execute("SELECT status FROM xxits_pr_headers WHERE id=?", [req.params.id]);
    if (!existing) return res.status(404).json({ error: "PR not found" });
    if (!["Draft","Pending"].includes(existing.status))
      return res.status(400).json({ error: `Cannot edit PR in status: ${existing.status}` });

    await conn.execute(`
      UPDATE xxits_pr_headers SET
        pr_date=?, mrq_number=?, location_code=?, location_name=?, remarks=?,
        originator_code=?, originator_name=?, requestor=?, purchaser=?,
        job_number=?, job_brief=?, sub_job_brief=?,
        vessel=?, ship_manager=?, co=?, reason_code=?, brand=?,
        supplier=?, supplier_site=?, contact_person=?, buyer=?,
        rfq_required=?, reserve_po=?, operating_unit=?,
        budget_code=?, cost_center=?, delivery_date=?, shipping_method=?, priority=?
      WHERE id=?`,
      [
        h.prDate, h.mrqNumber||null, h.locationCode||null, h.locationName||null, h.remarks||null,
        h.originatorCode||null, h.originatorName||null, h.requestor||null, h.purchaser||null,
        h.jobNumber||null, h.jobBrief||null, h.subJobBrief||null,
        h.vessel||null, h.shipManager||null, h.co||null, h.reasonCode||null, h.brand||null,
        h.supplier||null, h.supplierSite||null, h.contactPerson||null, h.buyer||null,
        h.rfqRequired ? 1 : 0, h.reservePo||"Optional", h.operatingUnit||null,
        h.budgetCode||null, h.costCenter||null, h.deliveryDate||null, h.shippingMethod||"Sea Freight", h.priority||"Normal",
        req.params.id,
      ]
    );

    // Replace lines: delete old, insert new
    await conn.execute("DELETE FROM xxits_pr_lines WHERE pr_header_id=?", [req.params.id]);
    const lines = h.lines || [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      await conn.execute(`
        INSERT INTO xxits_pr_lines
          (id, pr_header_id, line_number, job_number, sub_job, item_code, description, remarks, uom, quantity, unit_price)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [uuidv4(), req.params.id, i+1, l.jobNo||null, l.subJob||"1", l.itemCode||null, l.description||null, l.remarks||null, l.uom||"PC", l.quantity||0, l.unitPrice||0]
      );
    }

    await auditLog(conn, req.params.id, "UPDATE", existing.status, existing.status, h.createdBy||"SYSTEM");
    await conn.commit();

    // Return updated
    const [[updated]] = await pool.execute("SELECT * FROM xxits_pr_headers WHERE id=?", [req.params.id]);
    res.json(mapHeader(updated));
  } catch (err) {
    await conn.rollback();
    console.error("PUT /api/pr/:id error:", err);
    res.status(500).json({ error: err.message });
  } finally { conn.release(); }
});

// ════════════════════════════════════════════════════════════════
// PATCH /api/pr/:id/approve
// ════════════════════════════════════════════════════════════════
app.patch("/api/pr/:id/approve", async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[row]] = await conn.execute("SELECT status FROM xxits_pr_headers WHERE id=?", [req.params.id]);
    if (!row) return res.status(404).json({ error: "PR not found" });
    if (!["Draft","Pending"].includes(row.status))
      return res.status(400).json({ error: `Cannot approve PR in status: ${row.status}` });

    const by = req.body?.by || "CURRENT_USER";
    await conn.execute(
      "UPDATE xxits_pr_headers SET status='Approved', approved_on=NOW(), approved_by=? WHERE id=?",
      [by, req.params.id]
    );
    await auditLog(conn, req.params.id, "APPROVE", row.status, "Approved", by);
    await conn.commit();
    res.json({ success: true, status: "Approved" });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally { conn.release(); }
});

// ════════════════════════════════════════════════════════════════
// PATCH /api/pr/:id/confirm
// ════════════════════════════════════════════════════════════════
app.patch("/api/pr/:id/confirm", async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[row]] = await conn.execute("SELECT status FROM xxits_pr_headers WHERE id=?", [req.params.id]);
    if (!row) return res.status(404).json({ error: "PR not found" });
    if (row.status !== "Approved")
      return res.status(400).json({ error: "PR must be Approved before Confirm" });

    const by = req.body?.by || "CURRENT_USER";
    await conn.execute(
      "UPDATE xxits_pr_headers SET status='Confirmed', confirmed_on=NOW(), confirmed_by=? WHERE id=?",
      [by, req.params.id]
    );
    await auditLog(conn, req.params.id, "CONFIRM", "Approved", "Confirmed", by);
    await conn.commit();
    res.json({ success: true, status: "Confirmed" });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally { conn.release(); }
});

// ════════════════════════════════════════════════════════════════
// PATCH /api/pr/:id/reject
// ════════════════════════════════════════════════════════════════
app.patch("/api/pr/:id/reject", async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[row]] = await conn.execute("SELECT status FROM xxits_pr_headers WHERE id=?", [req.params.id]);
    if (!row) return res.status(404).json({ error: "PR not found" });
    if (["Confirmed","Rejected"].includes(row.status))
      return res.status(400).json({ error: `Cannot reject PR in status: ${row.status}` });

    const by    = req.body?.by    || "CURRENT_USER";
    const notes = req.body?.notes || "";
    await conn.execute(
      "UPDATE xxits_pr_headers SET status='Rejected', rejected_on=NOW(), rejected_by=? WHERE id=?",
      [by, req.params.id]
    );
    await auditLog(conn, req.params.id, "REJECT", row.status, "Rejected", by, notes);
    await conn.commit();
    res.json({ success: true, status: "Rejected" });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally { conn.release(); }
});

// ════════════════════════════════════════════════════════════════
// POST /api/pr/:id/attachments  — upload file
// ════════════════════════════════════════════════════════════════
app.post("/api/pr/:id/attachments", upload.single("file"), async (req, res) => {
  try {
    const { originalname, mimetype, size, filename } = req.file;
    const storagePath = `/uploads/${filename}`;
    const uploadedBy  = req.body?.uploadedBy || "CURRENT_USER";

    const [result] = await pool.execute(`
      INSERT INTO xxits_pr_attachments
        (id, pr_header_id, file_name, file_type, file_size_kb, storage_path, uploaded_by)
      VALUES (?,?,?,?,?,?,?)`,
      [uuidv4(), req.params.id, originalname, mimetype, Math.ceil(size/1024), storagePath, uploadedBy]
    );
    res.status(201).json({ success: true, fileName: originalname });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
// GET /api/pr/:id/audit  — audit log for a PR
// ════════════════════════════════════════════════════════════════
app.get("/api/pr/:id/audit", async (req, res) => {
  try {
    const [rows] = await pool.execute(
      "SELECT * FROM xxits_pr_audit_log WHERE pr_header_id=? ORDER BY changed_at DESC",
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════
// GET /api/pr/:id/attachments  — list attachments for a PR
// ════════════════════════════════════════════════════════════════
app.get("/api/pr/:id/attachments", async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT 
         id, pr_header_id, file_name, file_type,
         file_size_kb, storage_path, uploaded_at, uploaded_by
       FROM xxits_pr_attachments
       WHERE pr_header_id = ?
       ORDER BY uploaded_at DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    console.error("GET /api/pr/:id/attachments error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
// DELETE /api/pr/:id/attachments/:attachId  — delete attachment
// ════════════════════════════════════════════════════════════════
app.delete("/api/pr/:id/attachments/:attachId", async (req, res) => {
  try {
    // Get file path before deleting DB row
    const [[row]] = await pool.execute(
      "SELECT storage_path FROM xxits_pr_attachments WHERE id = ? AND pr_header_id = ?",
      [req.params.attachId, req.params.id]
    );
    if (!row) return res.status(404).json({ error: "Attachment not found" });

    // Delete from DB
    await pool.execute(
      "DELETE FROM xxits_pr_attachments WHERE id = ? AND pr_header_id = ?",
      [req.params.attachId, req.params.id]
    );

    // Delete physical file
    const filePath = path.join(__dirname, row.storage_path);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

    res.json({ success: true });
  } catch (err) {
    console.error("DELETE /api/pr/:id/attachments/:attachId error:", err);
    res.status(500).json({ error: err.message });
  }
});
app.listen(PORT, () => console.log(`🚀 PR API running on http://localhost:${PORT}`));
