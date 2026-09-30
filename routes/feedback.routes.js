const { Router } = require("express");
const { ObjectId } = require("mongodb");
const { waitUntil } = require("@vercel/functions");
const { emailSender, logEmailOutcome } = require("../emailSender");
const upload = require("../middleware/upload");
const { verifyToken, verifyAdmin } = require("../middleware/auth");

const router = Router();

module.exports = ({ usersCollection, bookingMockCollection, client }) => {
  // Teacher-accessible: email match enforced inside the handler
  router.post("/admin/save-feedback", verifyToken, async (req, res) => {
    try {
      const { userId, scheduleId, segment, feedback, marks, admin, adminEmail } = req.body;

      if (!userId || !scheduleId || !segment || feedback === undefined || !adminEmail) {
        return res.status(400).json({
          success: false,
          message: "Missing required fields (userId, scheduleId, segment, feedback, adminEmail).",
        });
      }
      if (!ObjectId.isValid(userId)) {
        return res.status(400).json({ success: false, message: "Invalid userId" });
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
      const assignedEmail = (teacherEmailMap[segment] || "").trim().toLowerCase();
      const submittingEmail = adminEmail.trim().toLowerCase();
      if (!assignedEmail || assignedEmail !== submittingEmail) {
        return res.status(403).json({
          success: false,
          message: `Unauthorized: Only ${assignedEmail || "assigned teacher"} can save feedback for ${segment}.`,
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

      const updateData = {
        $push: { [`resultsBySchedule.${scheduleId}`]: feedbackEntry },
        $set: { [`feedbackStatusBySchedule.${scheduleId}.${segment}`]: true },
      };

      await usersCollection.updateOne({ _id: new ObjectId(userId) }, updateData);
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

  // Teacher-accessible
  router.get("/admin/get-admin-section/:userId/:scheduleId", verifyToken, async (req, res) => {
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

  // Teacher-accessible
  router.get("/admin/feedback-status/:userId/:scheduleId", verifyToken, async (req, res) => {
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

  // Teacher-accessible
  router.get("/admin/assigned-teachers/:userId/:scheduleId", verifyToken, async (req, res) => {
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
        { _id: new ObjectId(bookingId), location: "Home" },
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
        { _id: new ObjectId(bookingId) },
        {
          $set: {
            [`teacher${skill}`]: teacher,
            [`teacher${skill}Email`]: email.toLowerCase().trim(),
          },
        },
        { returnDocument: "after", session }
      );

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

  // Teacher-accessible
  router.get("/admin/trf-email-status/:userId/:scheduleId", verifyToken, async (req, res) => {
    try {
      const { userId, scheduleId } = req.params;

      if (!ObjectId.isValid(userId)) {
        return res.status(400).json({ sent: false, message: "Invalid user ID" });
      }
      if (!scheduleId) {
        return res.status(400).json({ sent: false, message: "scheduleId is required" });
      }

      const bookingDoc = await bookingMockCollection.findOne(
        { userId, scheduleId },
        { projection: { trfEmailed: 1, trfEmailAt: 1 } }
      );
      if (bookingDoc?.trfEmailed) {
        return res.json({ sent: true, lastSentAt: bookingDoc.trfEmailAt || null });
      }

      if (ObjectId.isValid(scheduleId)) {
        const homeDoc = await bookingMockCollection.findOne(
          { _id: new ObjectId(scheduleId), userId, location: "Home" },
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
          _id: new ObjectId(scheduleId), userId, location: "Home",
        });
        if (home) { booking = home; isHomeBooking = true; }
      }

      if (!booking) {
        booking =
          (await bookingMockCollection.findOne({ userId, scheduleId })) ||
          (await bookingMockCollection.find({ userId }).sort({ bookingDate: -1, _id: -1 }).limit(1).next());
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
            await bookingMockCollection.updateOne(
              { userId, scheduleId },
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
