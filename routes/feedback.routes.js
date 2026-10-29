const { Router } = require("express");
const { ObjectId } = require("mongodb");
const { waitUntil } = require("@vercel/functions");
const { emailSender, logEmailOutcome } = require("../emailSender");
const upload = require("../middleware/upload");
const { verifyAdmin, verifyTeacherOrAdmin, ownerOrStaff, staffOnly } = require("../middleware/auth");

// Dynamic Mongo key paths are built from `scheduleId` and `segment`, so both
// must be safe before they reach an update. Real schedule ids are Mongo
// ObjectId hex strings; the pattern keeps that and other safe slugs while
// rejecting dots/`$` (which would create or address nested/injected fields).
const SAFE_SCHEDULE_ID = /^[A-Za-z0-9_-]{1,64}$/;
// Keys that would resolve through the JS prototype chain when read off a
// user document (e.g. `user.teachersBySchedule["constructor"]`).
const RESERVED_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const FEEDBACK_SEGMENTS = ["listening", "reading", "writing", "speaking"];

// FIX-02b: a cancelled booking is kept for history (FIX-02a) but is not an
// active booking, so it must never be picked as the target of a teacher
// assignment or a TRF lookup/send. Kept local to this feature rather than
// promoted into shared/ for a single field predicate.
const ACTIVE_BOOKING_FILTER = { status: { $ne: "cancelled" } };

const router = Router();

module.exports = ({ usersCollection, bookingMockCollection, client }) => {
  // Teacher-accessible: the authenticated live identity must match the teacher
  // assigned to this segment. The legacy body field `adminEmail` is still
  // accepted for client compatibility but is never used for authorization.
  router.post("/admin/save-feedback", verifyTeacherOrAdmin, async (req, res) => {
    try {
      const { userId, scheduleId, segment, feedback, marks, admin } = req.body;

      if (!userId || !scheduleId || !segment || feedback === undefined) {
        return res.status(400).json({
          success: false,
          message: "Missing required fields (userId, scheduleId, segment, feedback).",
        });
      }
      if (!ObjectId.isValid(userId)) {
        return res.status(400).json({ success: false, message: "Invalid userId" });
      }
      if (
        typeof scheduleId !== "string" ||
        !SAFE_SCHEDULE_ID.test(scheduleId) ||
        RESERVED_KEYS.has(scheduleId)
      ) {
        return res.status(400).json({ success: false, message: "Invalid scheduleId." });
      }
      if (typeof segment !== "string" || !FEEDBACK_SEGMENTS.includes(segment)) {
        return res.status(400).json({ success: false, message: "Invalid feedback segment." });
      }

      const user = await usersCollection.findOne({ _id: new ObjectId(userId) });
      if (!user) return res.status(404).json({ success: false, message: "User not found." });

      const t = user.teachersBySchedule?.[scheduleId] || {};
      const teacherEmailMap = {
        listening: t.teacherLEmail || user.teacherLEmail,
        reading: t.teacherREmail || user.teacherREmail,
        writing: t.teacherWEmail || user.teacherWEmail,
        speaking: t.teacherSEmail || user.teacherSEmail,
      };
      const assignedEmail = String(teacherEmailMap[segment] || "").trim().toLowerCase();
      // Identity comes only from the verified live account, never the body.
      const submittingEmail = String(req.user.email || "").trim().toLowerCase();
      if (!assignedEmail || !submittingEmail || assignedEmail !== submittingEmail) {
        // Never disclose which teacher is assigned.
        return res.status(403).json({
          success: false,
          message: `Unauthorized: you are not the assigned teacher for ${segment} on this schedule.`,
        });
      }

      if (segment === "writing" && (typeof feedback !== "object" || typeof marks !== "object"))
        return res.status(400).json({ success: false, message: "Invalid format for writing feedback or marks." });
      if (segment === "speaking" && (typeof feedback !== "string" || typeof marks !== "object"))
        return res.status(400).json({ success: false, message: "Invalid format for speaking feedback or marks." });

      if (segment === "speaking" || segment === "writing") {
        if (typeof admin !== "string" || !admin.trim()) {
          return res.status(400).json({ success: false, message: "Signature is required for this segment." });
        }
      }

      const flagPath = `feedbackStatusBySchedule.${scheduleId}.${segment}`;
      const resultsPath = `resultsBySchedule.${scheduleId}`;

      // UX fast path only; the conditional update below is the real lock.
      const alreadySaved = !!(user.feedbackStatusBySchedule?.[scheduleId]?.[segment]);
      if (alreadySaved) {
        return res.status(409).json({
          success: false,
          message: `Feedback for ${segment} already saved for this schedule.`,
        });
      }

      const adminValue = typeof admin === "string" ? admin.trim() : admin;
      const feedbackEntry = {
        segment,
        feedback,
        marks: marks ?? null,
        admin:
          segment === "speaking" || segment === "writing"
            ? String(adminValue).slice(0, 200)
            : adminValue,
        timestamp: new Date().toISOString(),
      };

      // One atomic write: the filter refuses the update when the status flag is
      // already set OR a result entry for this segment already exists (legacy
      // rows written before the flag existed). `$push` and `$set` therefore
      // land together, and concurrent duplicates cannot both match.
      const updateResult = await usersCollection.updateOne(
        {
          _id: new ObjectId(userId),
          [flagPath]: { $ne: true },
          [`${resultsPath}.segment`]: { $ne: segment },
        },
        {
          $push: { [resultsPath]: feedbackEntry },
          $set: { [flagPath]: true },
        }
      );

      if (updateResult.matchedCount === 0) {
        // Distinguish "user disappeared" from "already recorded". A legacy
        // result without its status flag also lands here and is reported as a
        // conflict, never as a missing user.
        const stillExists = await usersCollection.findOne(
          { _id: new ObjectId(userId) },
          { projection: { _id: 1 } }
        );
        if (!stillExists) {
          return res.status(404).json({ success: false, message: "User not found." });
        }
        return res.status(409).json({
          success: false,
          message: `Feedback for ${segment} already saved for this schedule.`,
        });
      }

      return res.status(200).json({ success: true, message: "Feedback saved successfully." });
    } catch (err) {
      console.error("❌ Save feedback error:", err);
      return res.status(500).json({ success: false, message: "Server error." });
    }
  });

  router.put("/admin/save-admin-section", verifyAdmin, async (req, res) => {
    try {
      const {
        userId, scheduleId, overall, proficiency, resultDate,
        schemeCode, comments, adminSignature, centreName, testDate,
      } = req.body;

      if (!userId || !scheduleId) {
        return res.status(400).json({ success: false, message: "userId and scheduleId are required" });
      }
      if (!ObjectId.isValid(userId)) {
        return res.status(400).json({ success: false, message: "Invalid userId" });
      }

      const section = {
        overallScore: overall ?? null,
        proficiencyLevel: proficiency ?? null,
        resultDate: resultDate ?? null,
        schemeCode: schemeCode ?? null,
        adminComments: comments ?? null,
        adminSignature: adminSignature ?? null,
        centreName: centreName ?? null,
        testDate: testDate ?? null,
        updatedAt: new Date(),
      };

      const result = await usersCollection.updateOne(
        { _id: new ObjectId(userId) },
        { $set: { [`adminSectionBySchedule.${scheduleId}`]: section } }
      );

      if (result.matchedCount === 0) {
        return res.status(404).json({ success: false, message: "User not found" });
      }

      res.status(200).json({ success: true, message: "Admin section saved successfully" });
    } catch (error) {
      console.error("❌ Error saving admin section:", error);
      res.status(500).json({ success: false, message: "Internal server error" });
    }
  });

  // Owner-or-staff (FIX-03): a student may read their own TRF admin section;
  // staff keep the access their dashboards need.
  router.get("/admin/get-admin-section/:userId/:scheduleId", ownerOrStaff("userId"), async (req, res) => {
    try {
      const { userId, scheduleId } = req.params;
      if (!ObjectId.isValid(userId))
        return res.status(400).json({ success: false, message: "Invalid userId" });

      const user = await usersCollection.findOne({ _id: new ObjectId(userId) });
      if (!user) return res.status(404).json({ success: false, message: "User not found" });

      const s = user.adminSectionBySchedule?.[scheduleId] || {};
      const {
        adminComments = null, schemeCode = null, resultDate = null,
        adminSignature = null, overallScore = null, proficiencyLevel = null,
        centreName = null, testDate = null,
      } = s;

      res.status(200).json({
        adminComments, schemeCode, resultDate, adminSignature,
        overallScore, proficiencyLevel, centreName, testDate,
      });
    } catch (err) {
      console.error("Error fetching admin section:", err);
      res.status(500).json({ success: false, message: "Internal server error" });
    }
  });

  // Owner-or-staff (FIX-03)
  router.get("/admin/feedback-status/:userId/:scheduleId", ownerOrStaff("userId"), async (req, res) => {
    try {
      const { userId, scheduleId } = req.params;
      if (!ObjectId.isValid(userId)) {
        return res.status(400).json({ success: false, message: "Invalid userId." });
      }

      const user = await usersCollection.findOne({ _id: new ObjectId(userId) });
      if (!user) return res.status(404).json({ success: false, message: "User not found." });

      const resultArray = user.resultsBySchedule?.[scheduleId] || [];
      const feedbackFlags = user.feedbackStatusBySchedule?.[scheduleId] || {};

      let firstName = "", lastName = "";
      if (user.name) {
        const parts = user.name.trim().split(/\s+/);
        firstName = parts[0] || "";
        lastName = parts.slice(1).join(" ") || "";
      }

      const dateOfBirth = user.dateofbirth
        ? user.dateofbirth.replace(/(\d{2})-(\d{2})-(\d{4})/, "$3-$2-$1")
        : "";

      const status = {
        firstName: firstName || "",
        lastName: lastName || "",
        dateOfBirth: dateOfBirth || "",
        testDate: user.adminSectionBySchedule?.[scheduleId]?.testDate || "",
        centreName: user.adminSectionBySchedule?.[scheduleId]?.centreName || "",
        sex: user.sex || "",
        schemeCode: user.adminSectionBySchedule?.[scheduleId]?.schemeCode || "",
        listening: !!feedbackFlags.listening,
        reading: !!feedbackFlags.reading,
        writing: !!feedbackFlags.writing,
        speaking: !!feedbackFlags.speaking,
        listeningFeedback: "", readingFeedback: "", speakingFeedback: "",
        listeningMarks: "", readingMarks: "", speakingMarks: "",
        speakingFC: "", speakingLR: "", speakingGRA: "", speakingPRO: "",
        writingScores: {
          task1_overall: "", task1_TA: "", task1_CC: "", task1_LR: "", task1_GRA: "",
          task2_overall: "", task2_TR: "", task2_CC: "", task2_LR: "", task2_GRA: "",
        },
        writingTask1: [], writingTask2: [],
        task1Notes: ["", "", "", "", ""], task2Notes: ["", "", "", "", ""],
        writingSign: "", speakingSign: "",
        timestamps: { listening: "", reading: "", writing: "", speaking: "" },
      };

      for (const entry of resultArray) {
        const seg = entry.segment;
        const marks = entry.marks;
        const fb = entry.feedback;
        const ts = entry.timestamp || "";

        if (seg === "listening") {
          status.listeningFeedback = fb || "";
          status.listeningMarks = marks || "";
          status.timestamps.listening = ts;
        } else if (seg === "reading") {
          status.readingFeedback = fb || "";
          status.readingMarks = marks || "";
          status.timestamps.reading = ts;
        } else if (seg === "speaking") {
          status.speakingFeedback = fb || "";
          status.speakingMarks = marks?.Total || "";
          status.speakingFC = marks?.FC || "";
          status.speakingLR = marks?.LR || "";
          status.speakingGRA = marks?.GRA || "";
          status.speakingPRO = marks?.PRO || "";
          status.speakingSign = entry.admin || "";
          status.timestamps.speaking = ts;
        } else if (seg === "writing") {
          status.writingScores = marks || status.writingScores;
          status.writingTask1 = fb?.writingTask1 || [];
          status.writingTask2 = fb?.writingTask2 || [];
          status.task1Notes = fb?.task1Notes || ["", "", "", "", ""];
          status.task2Notes = fb?.task2Notes || ["", "", "", "", ""];
          status.writingSign = entry.admin || "";
          status.timestamps.writing = ts;
        }
      }

      return res.status(200).json({ success: true, status });
    } catch (err) {
      console.error("Feedback status error:", err.stack || err);
      return res.status(500).json({ success: false, message: "Server error." });
    }
  });

  router.put("/admin/users/:userId/schedules/:scheduleId/teacher", verifyAdmin, async (req, res) => {
    const { userId, scheduleId } = req.params;
    const { skill, teacher, email } = req.body;

    if (!ObjectId.isValid(userId)) return res.status(400).json({ message: "Invalid user ID." });
    if (!scheduleId) return res.status(400).json({ message: "scheduleId is required." });
    if (!["L", "W", "R", "S"].includes(skill)) return res.status(400).json({ message: "Invalid skill." });
    if (!teacher || typeof teacher !== "string") return res.status(400).json({ message: "Invalid teacher value." });
    if (!email || typeof email !== "string") return res.status(400).json({ message: "Teacher email is required." });

    try {
      const updateFields = {
        [`teachersBySchedule.${scheduleId}.teacher${skill}`]: teacher,
        [`teachersBySchedule.${scheduleId}.teacher${skill}Email`]: email.toLowerCase().trim(),
      };

      const result = await usersCollection.updateOne(
        { _id: new ObjectId(userId) },
        { $set: updateFields }
      );

      if (result.matchedCount === 0) return res.status(404).json({ message: "User not found." });

      return res.status(200).json({
        success: true,
        message: `Teacher for ${skill} updated to ${teacher} (schedule ${scheduleId})`,
      });
    } catch (error) {
      console.error("Error updating teacher:", error);
      return res.status(500).json({ message: "Server error. Please try again." });
    }
  });

  // Staff only (FIX-03): this returns the assigned-teacher email map, which no
  // student may see. Fails closed when the live identity cannot be verified.
  router.get("/admin/assigned-teachers/:userId/:scheduleId", staffOnly, async (req, res) => {
    const { userId, scheduleId } = req.params;

    if (!ObjectId.isValid(userId)) {
      return res.status(400).json({ message: "Invalid user ID format" });
    }
    if (!scheduleId) {
      return res.status(400).json({ message: "scheduleId is required" });
    }

    try {
      const user = await usersCollection.findOne(
        { _id: new ObjectId(userId) },
        {
          projection: {
            teachersBySchedule: 1,
            teacherLEmail: 1, teacherREmail: 1, teacherWEmail: 1, teacherSEmail: 1,
          },
        }
      );
      if (!user) return res.status(404).json({ message: "User not found" });

      const t = user.teachersBySchedule?.[scheduleId] || {};
      return res.json({
        teacherL: t.teacherLEmail?.toLowerCase().trim() || user.teacherLEmail?.toLowerCase().trim() || null,
        teacherR: t.teacherREmail?.toLowerCase().trim() || user.teacherREmail?.toLowerCase().trim() || null,
        teacherW: t.teacherWEmail?.toLowerCase().trim() || user.teacherWEmail?.toLowerCase().trim() || null,
        teacherS: t.teacherSEmail?.toLowerCase().trim() || user.teacherSEmail?.toLowerCase().trim() || null,
      });
    } catch (error) {
      console.error("Error fetching assigned teacher emails:", error);
      return res.status(500).json({ message: "Server error" });
    }
  });

  router.put("/admin/bookings/:bookingId/teacher", verifyAdmin, async (req, res) => {
    const { bookingId } = req.params;
    const { skill, teacher, email } = req.body;

    if (!ObjectId.isValid(bookingId)) {
      return res.status(400).json({ message: "Invalid booking ID." });
    }
    if (!["L", "W", "R", "S"].includes(skill)) {
      return res.status(400).json({ message: "Invalid skill parameter" });
    }
    if (!teacher || !email) {
      return res.status(400).json({ message: "Teacher and email are required" });
    }

    let session;

    try {
      session = client.startSession();
      session.startTransaction();

      const booking = await bookingMockCollection.findOne(
        { _id: new ObjectId(bookingId), location: "Home", ...ACTIVE_BOOKING_FILTER },
        { session }
      );

      if (!booking) {
        await session.abortTransaction();
        await session.endSession();
        return res.status(404).json({ message: "Home booking not found" });
      }

      const userId = booking.userId;

      await usersCollection.findOneAndUpdate(
        { _id: new ObjectId(userId) },
        {
          $set: {
            [`teachersBySchedule.${bookingId}.teacher${skill}`]: teacher,
            [`teachersBySchedule.${bookingId}.teacher${skill}Email`]: email.toLowerCase().trim(),
          },
        },
        { session }
      );

      const updateBookingResult = await bookingMockCollection.findOneAndUpdate(
        { _id: new ObjectId(bookingId), ...ACTIVE_BOOKING_FILTER },
        {
          $set: {
            [`teacher${skill}`]: teacher,
            [`teacher${skill}Email`]: email.toLowerCase().trim(),
          },
        },
        { returnDocument: "after", session }
      );

      // The booking was readable a moment ago in this same transaction; if it
      // can no longer be updated it was cancelled by a competing request.
      if (!updateBookingResult) {
        await session.abortTransaction();
        await session.endSession();
        return res.status(409).json({ message: "This booking was cancelled while the teacher was being assigned." });
      }

      await session.commitTransaction();
      await session.endSession();

      return res.status(200).json({
        success: true,
        message: `Teacher for ${skill} updated for home booking`,
        booking: updateBookingResult,
      });
    } catch (error) {
      console.error("Error updating teacher assignment:", error);
      if (session) {
        try {
          await session.abortTransaction();
          await session.endSession();
        } catch (e) {
          console.error("Error cleaning up session:", e);
        }
      }
      return res.status(500).json({ message: "Internal server error" });
    }
  });

  // Owner-or-staff (FIX-03)
  router.get("/admin/trf-email-status/:userId/:scheduleId", ownerOrStaff("userId"), async (req, res) => {
    try {
      const { userId, scheduleId } = req.params;

      if (!ObjectId.isValid(userId)) {
        return res.status(400).json({ sent: false, message: "Invalid user ID" });
      }
      if (!scheduleId) {
        return res.status(400).json({ sent: false, message: "scheduleId is required" });
      }

      const bookingDoc = await bookingMockCollection.findOne(
        { userId, scheduleId, ...ACTIVE_BOOKING_FILTER },
        { projection: { trfEmailed: 1, trfEmailAt: 1 } }
      );
      if (bookingDoc?.trfEmailed) {
        return res.json({ sent: true, lastSentAt: bookingDoc.trfEmailAt || null });
      }

      if (ObjectId.isValid(scheduleId)) {
        const homeDoc = await bookingMockCollection.findOne(
          { _id: new ObjectId(scheduleId), userId, location: "Home", ...ACTIVE_BOOKING_FILTER },
          { projection: { trfEmailed: 1, trfEmailAt: 1 } }
        );
        if (homeDoc?.trfEmailed) {
          return res.json({ sent: true, lastSentAt: homeDoc.trfEmailAt || null });
        }
      }

      const user = await usersCollection.findOne(
        { _id: new ObjectId(userId) },
        { projection: { [`trfEmailsBySchedule.${scheduleId}`]: 1 } }
      );
      const mirror = user?.trfEmailsBySchedule?.[scheduleId];
      if (mirror?.lastSentAt) {
        return res.json({ sent: true, lastSentAt: mirror.lastSentAt });
      }

      return res.json({ sent: false });
    } catch (err) {
      console.error("status route failed:", err);
      return res.status(500).json({ sent: false, message: "Server error" });
    }
  });

  router.post("/admin/send-trf-email/:userId/:scheduleId", verifyAdmin, upload.single("file"), async (req, res) => {
    try {
      const { userId, scheduleId } = req.params;

      if (!ObjectId.isValid(userId)) {
        return res.status(400).json({ success: false, message: "Invalid user ID" });
      }
      if (!scheduleId) {
        return res.status(400).json({ success: false, message: "scheduleId is required" });
      }
      if (!req.file || !req.file.buffer) {
        return res.status(400).json({ success: false, message: 'PDF file is required (field name: "file")' });
      }

      const fmtDateLong = (d) =>
        d ? new Date(d).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }) : "N/A";

      const toYMD = (v) => {
        if (!v) return "";
        if (v instanceof Date && !isNaN(+v)) return v.toISOString().slice(0, 10);
        if (typeof v === "number") {
          const d = new Date(v);
          return isNaN(+d) ? "" : d.toISOString().slice(0, 10);
        }
        if (typeof v === "string") {
          const s = v.trim();
          if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
          if (/^\d{2}-\d{2}-\d{4}$/.test(s)) {
            const [dd, mm, yyyy] = s.split("-");
            return `${yyyy}-${mm}-${dd}`;
          }
          const d = new Date(s);
          if (!isNaN(+d)) return d.toISOString().slice(0, 10);
        }
        if (v && typeof v === "object") {
          const o = v;
          if (o.$date) { const d = new Date(o.$date); return isNaN(+d) ? "" : d.toISOString().slice(0, 10); }
          if (typeof o.seconds === "number") { const d = new Date(o.seconds * 1000); return isNaN(+d) ? "" : d.toISOString().slice(0, 10); }
          if (typeof o.toDate === "function") { const d = o.toDate(); if (d instanceof Date && !isNaN(+d)) return d.toISOString().slice(0, 10); }
        }
        return "";
      };

      const user = await usersCollection.findOne(
        { _id: new ObjectId(userId) },
        { projection: { email: 1, name: 1, adminSectionBySchedule: 1, dateOfBirth: 1, dateofbirth: 1, sex: 1 } }
      );
      if (!user) {
        return res.status(404).json({ success: false, message: "User not found" });
      }

      let booking = null;
      let isHomeBooking = false;

      if (ObjectId.isValid(scheduleId)) {
        const home = await bookingMockCollection.findOne({
          _id: new ObjectId(scheduleId), userId, location: "Home", ...ACTIVE_BOOKING_FILTER,
        });
        if (home) { booking = home; isHomeBooking = true; }
      }

      if (!booking) {
        booking =
          (await bookingMockCollection.findOne({ userId, scheduleId, ...ACTIVE_BOOKING_FILTER })) ||
          (await bookingMockCollection
            .find({ userId, ...ACTIVE_BOOKING_FILTER })
            .sort({ bookingDate: -1, _id: -1 })
            .limit(1)
            .next());
      }

      const sect = user.adminSectionBySchedule?.[scheduleId] || {};

      const testDate = booking?.bookingDate ? fmtDateLong(booking.bookingDate) : fmtDateLong(sect.testDate);
      const headlineDate = testDate !== "N/A" ? testDate : "[Test Date]";
      const studentName = (user.name || "Student").trim();

      const dobYMD =
        toYMD(user.dateOfBirth || user.dateofbirth || sect.dateOfBirth) || "YYYY-MM-DD";
      let sex = (user.sex || sect.sex || "").toString().trim().toUpperCase();
      sex = sex === "M" || sex === "F" ? sex : "M/F";

      const subject = req.body.subject || `Your Mock Test Result – ${headlineDate}`;
      const letterHTML = `
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="x-apple-disable-message-reformatting">
    <meta name="viewport" content="width=device-width, initial-scale=1">
  </head>
  <body style="margin:0;padding:0;background:#ffffff;">
    <div dir="ltr" style="margin:0;padding:0;color:#000;font:16px/1.6 Arial,Helvetica,sans-serif;text-align:left;">
      <div style="font-size:28px;font-weight:700;margin:0 0 16px 0;">
        Your Mock Test Result – ${headlineDate}
      </div>
      <div style="margin:0 0 12px 0;">Dear ${studentName},</div>
      <div style="margin:0 0 12px 0;">
        Your <strong>Luminedge Mock Test</strong> result for <strong>${headlineDate}</strong> has been
        published. Please find your <strong>Test Report Form (TRF)</strong> attached with this email.
      </div>
      <div style="margin:0 0 12px 0;">
        We encourage you to review the feedback carefully and plan your next steps. To achieve your
        target score, consider enrolling in our
        <a href="https://luminedge.com.bd/ielts" target="_blank" rel="noopener noreferrer"
           style="color:#1a73e8;text-decoration:underline;">Crash or Premium Courses</a>,
        designed to maximize your performance before the real exam.
      </div>
      <div style="margin:0 0 12px 0;">
        You may also book your upcoming mocks through the Luminedge portal.
      </div>
      <div style="margin:18px 0 4px 0;">Best regards,</div>
      <div style="margin:0;font-weight:700;">Team Luminedge</div>
    </div>
  </body>
</html>`.trim();

      const original = (req.file.originalname || "").trim();
      const filename = /\.pdf$/i.test(original)
        ? original
        : `IELTS_TRF_${(studentName || "Candidate").replace(/\s+/g, "_").toString()}_${scheduleId}.pdf`;

      // Respond immediately and send in the background (see /register in
      // auth.routes.js for why): this mail host's pipeline takes ~9s per
      // message even with a small attachment, which risks blowing Vercel's
      // function timeout if awaited here. The frontend already polls
      // /admin/trf-email-status/:userId/:scheduleId for the real outcome
      // (hydrateTrfSentStatus), rather than relying solely on this response,
      // so deferring the trfEmailed DB write to the background is safe.
      res.json({
        success: true,
        message: `TRF email queued for delivery to ${user.email}`,
        to: user.email,
        subject,
        filename,
        defaultsUsed: { dateOfBirth: dobYMD, sex },
      });

      const attachments = [
        {
          filename,
          content: req.file.buffer,
          contentType: req.file.mimetype || "application/pdf",
          contentDisposition: "attachment",
        },
      ];

      waitUntil(
        (async () => {
          const result = await emailSender(subject, user.email, req.body.message || letterHTML, attachments);
          logEmailOutcome(`TRF email to ${user.email}`, result);
          if (!result?.success) return;

          const now = new Date();

          if (isHomeBooking && booking?._id) {
            await bookingMockCollection.updateOne(
              { _id: booking._id },
              { $set: { trfEmailed: true, trfEmailAt: now } }
            );
          } else {
            // FIX-02b: mark only a still-active booking. Without this the write
            // could stamp a cancelled row for the same student/schedule and
            // leave the booking that was actually emailed looking unsent.
            await bookingMockCollection.updateOne(
              { userId, scheduleId, ...ACTIVE_BOOKING_FILTER },
              { $set: { trfEmailed: true, trfEmailAt: now } },
              { upsert: false }
            );
          }

          const mirrorPath = `trfEmailsBySchedule.${scheduleId}`;
          await usersCollection.updateOne(
            { _id: new ObjectId(userId) },
            {
              $set: {
                [`${mirrorPath}.lastSentAt`]: now,
                [`${mirrorPath}.lastSubject`]: subject,
                [`${mirrorPath}.lastFilename`]: filename,
                [`${mirrorPath}.to`]: user.email,
                lastTrfEmailAt: now,
              },
              $push: {
                [`${mirrorPath}.history`]: { at: now, subject, filename, to: user.email },
              },
            }
          );
        })().catch((err) => console.error("Error sending TRF email:", err))
      );
      return;
    } catch (err) {
      console.error("Error sending TRF email:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  });

  return router;
};
