const { Router } = require("express");
const { ObjectId } = require("mongodb");
const sanitizeHtml = require("sanitize-html");
const { waitUntil } = require("@vercel/functions");
const { emailSender, logEmailOutcome } = require("../emailSender");
const {
  verifyToken,
  verifyAdmin,
  verifyStaff,
  requireVerifiedIdentity,
  ownerOrStaff,
} = require("../middleware/auth");

const router = Router();

// FIX-03 / R05: bound the free-text profile-edit note so a student cannot store
// an arbitrarily large document on their own record. The approved audit rule is
// to TRIM an oversized note to this many characters (not to reject it), so the
// stored value is `note.slice(0, MAX_PROFILE_EDIT_NOTE)`.
const MAX_PROFILE_EDIT_NOTE = 1000;

// Compute a future ISO date from a duration string like "6 months" or "10 days"
function getFutureISODate(duration) {
  const [valueStr, unit] = (duration || "").split(" ");
  const value = parseInt(valueStr);
  if (!value || !unit) return new Date().toISOString();

  const now = new Date();
  switch (unit.toLowerCase()) {
    case "minute":
    case "minutes":
      now.setMinutes(now.getMinutes() + value);
      break;
    case "day":
    case "days":
      now.setDate(now.getDate() + value);
      break;
    case "month":
    case "months":
      now.setMonth(now.getMonth() + value);
      break;
    default:
      return new Date().toISOString();
  }
  return now.toISOString();
}

module.exports = ({ usersCollection }) => {
  router.get("/admin/users", verifyStaff, async (req, res, next) => {
    try {
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const reqLimit = parseInt(req.query.limit, 10) || 0;

      const q = {};

      if (req.query.status) q.status = String(req.query.status);
      if (req.query.role) q.role = String(req.query.role);

      const searchRaw = (req.query.search || "").toString().trim();
      if (searchRaw) {
        const s = searchRaw.toLowerCase();
        const esc = s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const starts = new RegExp("^" + esc);
        const contains = new RegExp(esc, "i");

        q.$or = [
          { nameLower: { $regex: starts } },
          { emailLower: { $regex: starts } },
          { passportNumberLower: { $regex: contains } },
          { transactionIdLower: { $regex: contains } },
          { name: { $regex: new RegExp("^" + esc, "i") } },
          { email: { $regex: new RegExp("^" + esc, "i") } },
          { passportNumber: { $regex: contains } },
          { transactionId: { $regex: contains } },
        ];
      }

      const projection = {
        password: 0,
        resultsBySchedule: 0,
        feedbackStatusBySchedule: 0,
        adminSectionBySchedule: 0,
        trfEmailsBySchedule: 0,
        mocks: 0,
      };

      const wantsAll = page === 1 && reqLimit >= 1000;
      const BULK_MAX = 10_000;

      let total;

      if (wantsAll && !searchRaw) {
        total = await usersCollection.countDocuments(q, { maxTimeMS: 3000 });

        if (total <= BULK_MAX) {
          const users = await usersCollection
            .find(q, { projection })
            .sort({ _id: -1 })
            .toArray();
          return res.json({ users, total });
        }
      }

      const cap = 500;
      const limit = Math.min(cap, Math.max(1, reqLimit || cap));
      const skip = (page - 1) * limit;

      if (!searchRaw && typeof total !== "number") {
        total = await usersCollection.countDocuments(q, { maxTimeMS: 3000 });
      }

      const users = await usersCollection
        .find(q, { projection })
        .sort({ _id: -1 })
        .skip(skip)
        .limit(limit)
        .maxTimeMS(4000)
        .toArray();

      return res.json({ users, total });
    } catch (err) {
      if (err?.code === 50) {
        return res.status(504).json({ message: "Query timed out. Try a smaller page/limit." });
      }
      next(err);
    }
  });

  router.get("/user/all", verifyAdmin, async (req, res) => {
    try {
      const users = await usersCollection
        .find({}, { projection: { password: 0 } })
        .toArray();
      res.json(users);
    } catch (error) {
      console.error("Error fetching users:", error);
      res.status(500).json({ message: "Error fetching users" });
    }
  });

  router.get("/user/status/:userId", ownerOrStaff("userId"), async (req, res) => {
    const { userId } = req.params;
    if (!ObjectId.isValid(userId)) {
      return res.status(400).json({ message: "Invalid user ID format." });
    }
    try {
      const user = await usersCollection.findOne(
        { _id: new ObjectId(userId) },
        { projection: { password: 0 } }
      );
      res.json({ user });
    } catch (err) {
      console.error("Error fetching user status:", err);
      res.status(500).json({ message: "Failed to load user status." });
    }
  });

  router.get("/profile/:userId", ownerOrStaff("userId"), async (req, res) => {
    const { userId } = req.params;

    if (!ObjectId.isValid(userId)) {
      return res.status(400).json({ success: false, message: "Invalid user ID" });
    }

    try {
      const user = await usersCollection.findOne(
        { _id: new ObjectId(userId) },
        {
          projection: {
            name: 1, email: 1, contactNo: 1, passportNumber: 1,
            transactionId: 1, createdAt: 1, profileChangeRequestStatus: 1,
          },
        }
      );

      if (!user) {
        return res.status(404).json({ success: false, message: "User not found" });
      }

      res.json({
        success: true,
        user: { ...user, phone: user.contactNo, passportId: user.passportNumber },
      });
    } catch (error) {
      console.error("Error fetching profile:", error);
      res.status(500).json({ success: false, message: "Server error" });
    }
  });

  router.get("/users/with-profile-request", verifyAdmin, async (_req, res) => {
    try {
      const users = await usersCollection
        .find({ profileChangeRequestStatus: "requested" })
        .project({
          _id: 1, name: 1, email: 1, profileChangeRequestStatus: 1,
          profileEditNote: 1, contactNo: 1, passportNumber: 1, transactionId: 1,
        })
        .toArray();

      return res.status(200).json({ success: true, users });
    } catch (error) {
      console.error("Error fetching requested users:", error);
      res.status(500).json({ success: false, message: "Server error" });
    }
  });

  router.put("/user/status/:userId", verifyAdmin, async (req, res) => {
    const { userId } = req.params;
    const { status } = req.body || {};

    if (!ObjectId.isValid(userId)) {
      return res.status(400).json({ message: "Invalid user ID format" });
    }

    // Values the admin UI can send (status dropdown: active/checked/completed;
    // "blocked" kept for completeness). Matches the frontend to avoid rejecting
    // legitimate updates.
    const ALLOWED_STATUSES = ["active", "checked", "completed", "blocked"];
    if (!ALLOWED_STATUSES.includes(status)) {
      return res.status(400).json({ message: `Invalid status. Allowed: ${ALLOWED_STATUSES.join(", ")}` });
    }

    try {
      const result = await usersCollection.updateOne(
        { _id: new ObjectId(userId) },
        { $set: { status } }
      );

      if (result.matchedCount === 0) {
        return res.status(404).json({ message: "User not found" });
      }

      res.json({ success: true, message: "User status updated successfully" });

      // Fire-and-forget, kept alive via waitUntil (see /register above for why):
      // everything here runs after the response is already sent, so without
      // waitUntil the runtime could freeze mid-lookup or mid-send.
      waitUntil(
        (async () => {
          const user = await usersCollection.findOne({ _id: new ObjectId(userId) });
          if (!user || status.toLowerCase() !== "completed") return;

          const safeName = sanitizeHtml(user.name || "Student", { allowedTags: [], allowedAttributes: {} });
          const portalUrl = (process.env.FRONTEND_URL || "").trim().replace(/\/$/, "");
          const safePortalUrl = /^https?:\/\//i.test(portalUrl) ? portalUrl.replace(/[<>"']/g, "") : "";
          const portalSentence = safePortalUrl
            ? `You can now log in and book your mock tests conveniently at <a href="${safePortalUrl}">${safePortalUrl}</a>.`
            : "You can now log in and book your mock tests conveniently through the portal.";
          const subject = "Your Account is Verified: Start Booking Mock Tests Now!";
          const messageContent = `
              <div>
                <p>Dear ${safeName},</p>
                <p>We are excited to inform you that your account on the Luminedge Mock Booking Portal has been verified. ${portalSentence}</p>
                <h4>Important Guidelines:</h4>
                <ul>
                  <li><strong>Photo ID Requirement:</strong> You must present a valid photo ID (Passport/NID) on the day of your mock test.</li>
                  <li><strong>Mock Test Terms & Conditions:</strong></li>
                  <ul>
                    <li>Purchased or course-provided mock test(s) must be used within 6 months of the Money Receipt (MR) date.</li>
                    <li>Free mock test(s) must be taken within 10 days of the MR date.</li>
                    <li>Mock test bookings must be made at least 24 hours in advance, subject to availability.</li>
                    <li>Rescheduling is possible if requested 24 hours before the booked test date.</li>
                    <li>Late arrivals, no-shows, invalid photo IDs, or expired service validity may result in forfeiting the test, with no refund requests entertained.</li>
                  </ul>
                </ul>
                <p>We recommend booking your mock tests early to secure your preferred schedule.</p>
                <p>For any assistance, feel free to contact us at 📞 01400-406374 | 01400-403475 | 01400-403486 | 01400-403487 | 01400-403493 | 01400-403494.</p>
                <p>Thank you for choosing Luminedge. We are committed to supporting your success!</p>
                <p>Best regards,</p>
                <p>The Luminedge Team</p>
              </div>
            `;

          const emailResult = await emailSender(subject, user.email, messageContent);
          logEmailOutcome(`Verification email to ${user.email}`, emailResult);
        })().catch((err) => console.error("Error sending verification email:", err))
      );
    } catch (error) {
      console.error("Error updating user status:", error);
      if (!res.headersSent) {
        res.status(500).json({ message: "Error updating user status." });
      }
    }
  });

  // FIX-03: the record owner comes from the verified session only. The legacy
  // `userId` the frontend still sends in the body is accepted and ignored, so a
  // forged body can never point this at another student's account.
  // R05: an over-long note is trimmed to MAX_PROFILE_EDIT_NOTE characters (the
  // audit's rule) instead of being rejected; only a non-string note is a 400.
  router.post("/user/request-profile-edit", verifyToken, requireVerifiedIdentity, async (req, res) => {
    try {
      const userId = String(req.user?.userId || "");
      const { note } = req.body || {};

      if (!ObjectId.isValid(userId)) {
        return res.status(400).json({ success: false, message: "Invalid or missing userId" });
      }
      if (note !== undefined && note !== null && typeof note !== "string") {
        return res.status(400).json({ success: false, message: "Note must be text" });
      }

      const storedNote =
        typeof note === "string" ? note.slice(0, MAX_PROFILE_EDIT_NOTE) : "";

      const result = await usersCollection.updateOne(
        { _id: new ObjectId(userId) },
        {
          $set: {
            profileChangeRequestStatus: "requested",
            profileEditNote: storedNote,
          },
        }
      );

      if (result.modifiedCount > 0) {
        return res.status(200).json({ success: true, message: "Profile change request submitted" });
      } else {
        return res.status(404).json({ success: false, message: "User not found or already requested" });
      }
    } catch (error) {
      console.error("Error requesting profile edit:", error);
      res.status(500).json({ success: false, message: "Internal server error" });
    }
  });

  router.put("/user/approve-profile-edit/:userId", verifyAdmin, async (req, res) => {
    try {
      const { userId } = req.params;
      const { name, email, phone, passportId, transactionId } = req.body || {};

      if (!ObjectId.isValid(userId)) {
        return res.status(400).json({ success: false, message: "Invalid user ID" });
      }

      // Build $set from only the fields actually provided, so omitting a field
      // leaves the stored value untouched instead of nulling it (the driver
      // serializes `undefined` to null by default).
      const updatePayload = {
        profileChangeRequestStatus: "default",
        profileEditNote: null,
        updatedAt: new Date(),
      };
      if (name !== undefined) updatePayload.name = name;
      if (phone !== undefined) updatePayload.contactNo = phone;
      if (passportId !== undefined) updatePayload.passportNumber = passportId;
      if (transactionId !== undefined) updatePayload.transactionId = transactionId;
      if (email !== undefined) {
        if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          return res.status(400).json({ success: false, message: "Invalid email format" });
        }
        updatePayload.email = email.toLowerCase();
      }

      const result = await usersCollection.updateOne(
        { _id: new ObjectId(userId) },
        { $set: updatePayload }
      );

      if (result.modifiedCount === 0) {
        return res.status(404).json({ success: false, message: "User not found or no changes made" });
      }

      res.status(200).json({ success: true, message: "User profile updated by admin" });
    } catch (error) {
      console.error("Error approving profile edit:", error);
      res.status(500).json({ success: false, message: "Server error" });
    }
  });

  router.put("/user/update-multiple/:userId", verifyAdmin, async (req, res) => {
    const { userId } = req.params;
    const { mocks } = req.body;

    try {
      if (!ObjectId.isValid(userId)) {
        return res.status(400).json({ success: false, message: "Invalid user ID" });
      }

      if (!Array.isArray(mocks) || mocks.length === 0) {
        return res.status(400).json({ success: false, message: "Mocks must be a non-empty array" });
      }

      const user = await usersCollection.findOne({ _id: new ObjectId(userId) });
      if (!user) {
        return res.status(404).json({ success: false, message: "User not found" });
      }

      const userMocks = Array.isArray(user.mocks) ? user.mocks : [];

      const uniqueMocks = mocks.filter(
        (mock) => !userMocks.some((existing) => existing.transactionId === mock.transactionId)
      );

      if (uniqueMocks.length === 0) {
        return res.status(400).json({ success: false, message: "All transaction IDs are duplicates" });
      }

      const entriesToAdd = uniqueMocks.map((entry) => ({
        ...entry,
        mock: Number(entry.mock),
        createdAt: new Date(),
      }));

      const totalMockToAdd = entriesToAdd.reduce((sum, e) => sum + (e.mock || 0), 0);

      const result = await usersCollection.updateOne(
        { _id: new ObjectId(userId) },
        {
          $push: { mocks: { $each: entriesToAdd } },
          $inc: { totalMock: totalMockToAdd, mock: totalMockToAdd },
        }
      );

      if (result.modifiedCount === 0) {
        return res.status(500).json({ success: false, message: "Failed to update user mocks" });
      }

      const emailHTML = `
    <h2>Dear ${sanitizeHtml(user.name || "", { allowedTags: [], allowedAttributes: {} })},</h2>
    <p>
      We are pleased to inform you that your mock test records have been successfully updated in our system.
      Please find your latest mock test details below:
    </p>

    ${entriesToAdd
      .map(
        (mock, i) => {
          const safe = (v) => sanitizeHtml(String(v || ""), { allowedTags: [], allowedAttributes: {} });
          return `
        <p>📝 <strong>Mock Test ${i + 1}</strong></p>
        <ul>
          <li><strong>Test Type:</strong> ${safe(mock.mockType)}</li>
          <li><strong>Mode:</strong> ${safe(mock.testType)}</li>
          ${mock.testSystem ? `<li><strong>Test System:</strong> ${safe(mock.testSystem)}</li>` : ""}
          <li><strong>Total Number of Mocks Added:</strong> ${safe(mock.mock)}</li>
          <li><strong>Updated Money Receipt (MR) Number:</strong> ${safe(mock.transactionId)}</li>
          <li><strong>Service Validity:</strong> ${safe(mock.mrValidation)}</li>
        </ul>
        <br/>
      `;
        }
      )
      .join("")}

    <p>If you have any questions or need further assistance, please don't hesitate to reach out to our support team.</p>

    <p>
      📞 <strong>01400-403474</strong> | <strong>01400-403475</strong> |
      <strong>01400-403486</strong> | <strong>01400-403487</strong> |
      <strong>01400-403493</strong> | <strong>01400-403494</strong>
    </p>

    <p>
      Thank you for choosing <strong>Luminedge</strong>.<br/>
      We're committed to supporting your journey to success.
    </p>

    <p>Best regards,<br/><strong>The Luminedge Team</strong></p>
  `;

      res.json({
        success: true,
        // No longer a synchronous outcome to report here (see below) — this
        // mail host's pipeline takes ~9s per message, so the notification is
        // sent in the background rather than blocking this response.
        message: "Mocks added; email notification is being sent",
        addedMocks: entriesToAdd,
      });

      waitUntil(
        emailSender("Email for Mock Test Details Update", user.email, emailHTML).then(
          (emailResult) => logEmailOutcome(`Mock test details email to ${user.email}`, emailResult)
        )
      );
    } catch (error) {
      console.error("Error during bulk update or sending email:", error);
      res.status(500).json({ success: false, message: "Server error" });
    }
  });

  router.put("/user/update-one/:userId", verifyAdmin, async (req, res) => {
    const { userId } = req.params;
    const { updatedMock, transactionId } = req.body;

    try {
      if (!ObjectId.isValid(userId)) {
        return res.status(400).json({ success: false, message: "Invalid user ID" });
      }

      if (!updatedMock || !transactionId) {
        return res.status(400).json({ success: false, message: "Missing updated mock data or transaction ID" });
      }

      const user = await usersCollection.findOne({ _id: new ObjectId(userId) });

      if (!user || !Array.isArray(user.mocks)) {
        return res.status(404).json({ success: false, message: "User or mocks not found" });
      }

      const mockIndex = user.mocks.findIndex(
        (mock) => String(mock.transactionId).trim() === String(transactionId).trim()
      );

      if (mockIndex === -1) {
        return res.status(404).json({ success: false, message: "Mock with given transaction ID not found" });
      }

      const prevMock = user.mocks[mockIndex];
      const prevMockValue = Number(prevMock.mock) || 0;
      const newMockValue = Number(updatedMock.mock) || 0;
      const deltaMock = newMockValue - prevMockValue;

      const currentTotalMock = user.totalMock || 0;
      const newTotalMock = currentTotalMock + deltaMock;

      if (newTotalMock < 0) {
        return res.status(400).json({ success: false, message: "Total mock count cannot go below zero" });
      }

      const updatedMockData = {
        ...prevMock,
        ...updatedMock,
        mock: newMockValue,
        updatedAt: new Date(),
        mrValidationExpiry: getFutureISODate(updatedMock.mrValidation),
      };

      const updatedMocks = [...user.mocks];
      updatedMocks[mockIndex] = updatedMockData;

      const result = await usersCollection.updateOne(
        { _id: new ObjectId(userId) },
        {
          $set: { mocks: updatedMocks },
          $inc: { totalMock: deltaMock, mock: deltaMock },
        }
      );

      if (result.modifiedCount === 0) {
        return res.status(500).json({ success: false, message: "Mock update failed" });
      }

      res.json({ success: true, message: "Mock updated successfully", updatedMock: updatedMockData });
    } catch (error) {
      console.error("❌ Error updating single mock:", error);
      res.status(500).json({ success: false, message: "Server error" });
    }
  });

  router.put("/user/block/:userId", verifyAdmin, async (req, res) => {
    const { userId } = req.params;
    const isDeleted = req.body?.isDeleted === true || req.body?.isDeleted === "true";

    if (!ObjectId.isValid(userId)) {
      return res.status(400).json({ message: "Invalid user ID format" });
    }

    try {
      const result = await usersCollection.updateOne(
        { _id: new ObjectId(userId) },
        { $set: { isDeleted } }
      );

      if (result.matchedCount === 0) {
        return res.status(404).json({ message: "User not found" });
      }
      res.json({
        success: true,
        message: `User ${isDeleted ? "blocked" : "unblocked"} successfully`,
      });
    } catch (error) {
      console.error("Error updating user status:", error);
      res.status(500).json({ message: "Error updating user status" });
    }
  });

  // Must be last — catches /user/:userId after all specific /user/* routes
  router.get("/user/:userId", ownerOrStaff("userId"), async (req, res) => {
    const { userId } = req.params;

    try {
      if (!ObjectId.isValid(userId)) {
        return res.status(400).json({ success: false, message: "Invalid user ID" });
      }

      const user = await usersCollection.findOne({ _id: new ObjectId(userId) });
      if (!user) {
        return res.status(404).json({ success: false, message: "User not found" });
      }

      const mocks = Array.isArray(user.mocks) ? user.mocks : [];
      const lastMock = mocks.length > 0 ? mocks[mocks.length - 1] : null;

      const responseData = {
        success: true,
        user: {
          name: user.name ?? "Unknown User",
          email: user.email ?? "No Email",
          totalMock: user.totalMock ?? 0,
          mock: user.mock ?? 0,
          transactionId: lastMock?.transactionId || user.transactionId || "N/A",
          mockType: lastMock?.mockType || user.mockType || "N/A",
          testSystem: lastMock?.testSystem || user.testSystem || "N/A",
          testType: lastMock?.testType || user.testType || "N/A",
          mrValidation: lastMock?.mrValidation || user.mrValidation || "N/A",
          status: user.status ?? "N/A",
        },
        mocks,
        lastMock,
      };

      res.json(responseData);
    } catch (error) {
      console.error("Error fetching user mock data:", error);
      res.status(500).json({ success: false, message: "Server error" });
    }
  });

  return router;
};
