const { Router } = require("express");
const { ObjectId } = require("mongodb");
const { verifyAdmin } = require("../middleware/auth");

const router = Router();

// Shared match filter builder for user stats queries
function buildMatchFilter({ from, to, role = "user" }) {
  const match = { role };
  if (from || to) {
    const tzOffset = "+06:00";
    match.createdAt = {};
    if (from) match.createdAt.$gte = new Date(`${from}T00:00:00${tzOffset}`);
    if (to) match.createdAt.$lte = new Date(`${to}T23:59:59.999${tzOffset}`);
  }
  return match;
}

// Shared aggregation stages that expand the mockTypes array from user docs
const expandMockTypes = [
  {
    $addFields: {
      mockTypes: {
        $cond: [
          { $gt: [{ $size: { $ifNull: ["$mocks", []] } }, 0] },
          "$mocks.mockType",
          { $cond: [{ $ifNull: ["$mockType", false] }, ["$mockType"], []] },
        ],
      },
    },
  },
  { $unwind: "$mockTypes" },
];

module.exports = ({ usersCollection, bookingMockCollection }) => {
  router.get("/admin/stats/users/mock-types/range", verifyAdmin, async (req, res, next) => {
    try {
      const { from, to, role } = req.query;
      const match = buildMatchFilter({ from, to, role });

      const totalUsers = await usersCollection.countDocuments(match);

      const pipeline = [
        { $match: match },
        { $project: { mocks: 1, mockType: 1 } },
        ...expandMockTypes,
        { $group: { _id: "$mockTypes", count: { $sum: 1 } } },
        { $project: { _id: 0, mockType: "$_id", count: 1 } },
        { $sort: { mockType: 1 } },
      ];

      const byMockType = await usersCollection.aggregate(pipeline, { maxTimeMS: 5000 }).toArray();

      res.json({ success: true, from: from || null, to: to || null, totalUsers, byMockType });
    } catch (err) {
      console.error("Error in /admin/stats/users/mock-types/range", err);
      next(err);
    }
  });

  router.get("/admin/stats/users/mock-types/monthly", verifyAdmin, async (req, res, next) => {
    try {
      const { from, to, role } = req.query;
      const match = buildMatchFilter({ from, to, role });

      const pipeline = [
        { $match: match },
        { $project: { createdAt: 1, mocks: 1, mockType: 1 } },
        ...expandMockTypes,
        {
          $group: {
            _id: {
              month: {
                $dateToString: { format: "%Y-%m", date: "$createdAt", timezone: "Asia/Dhaka" },
              },
              mockType: "$mockTypes",
            },
            count: { $sum: 1 },
          },
        },
        {
          $group: {
            _id: "$_id.month",
            byMockType: { $push: { mockType: "$_id.mockType", count: "$count" } },
          },
        },
        { $project: { _id: 0, month: "$_id", byMockType: 1 } },
        { $sort: { month: 1 } },
      ];

      const monthly = await usersCollection.aggregate(pipeline, { maxTimeMS: 5000 }).toArray();

      res.json({ success: true, from: from || null, to: to || null, monthly });
    } catch (err) {
      console.error("Error in /admin/stats/users/mock-types/monthly", err);
      next(err);
    }
  });

  router.get("/admin/stats/bookings/attendance", verifyAdmin, async (req, res) => {
    try {
      const attendanceTotals = await bookingMockCollection
        .aggregate([
          { $group: { _id: { $ifNull: ["$attendance", "not updated"] }, count: { $sum: 1 } } },
          { $project: { _id: 0, status: "$_id", count: 1 } },
          { $sort: { status: 1 } },
        ], { maxTimeMS: 5000 })
        .toArray();

      const uniqueUserDocs = await bookingMockCollection
        .aggregate([
          { $group: { _id: "$userId" } },
          { $count: "uniqueUserCount" },
        ], { maxTimeMS: 5000 })
        .toArray();

      const uniqueUserCount = (uniqueUserDocs[0] && uniqueUserDocs[0].uniqueUserCount) || 0;

      const monthlyByCourseStatus = await bookingMockCollection
        .aggregate([
          { $match: { bookingDate: { $type: "string" } } },
          {
            $addFields: {
              month: { $substr: ["$bookingDate", 0, 7] },
              course: { $ifNull: ["$testType", "Unknown"] },
              status: { $ifNull: ["$attendance", "not updated"] },
            },
          },
          {
            $group: {
              _id: { month: "$month", course: "$course", status: "$status" },
              count: { $sum: 1 },
            },
          },
          {
            $project: {
              _id: 0,
              month: "$_id.month",
              course: "$_id.course",
              status: "$_id.status",
              count: 1,
            },
          },
          { $sort: { month: 1, course: 1, status: 1 } },
        ], { maxTimeMS: 5000 })
        .toArray();

      return res.json({ attendanceTotals, uniqueUserCount, monthlyByCourseStatus });
    } catch (err) {
      console.error("Error in /api/v1/admin/stats/bookings/attendance", err);
      return res.status(500).json({ message: "Failed to load booking attendance stats" });
    }
  });

  router.get("/admin/user-budget/:userId/:scheduleId", verifyAdmin, async (req, res) => {
    try {
      const { userId, scheduleId } = req.params;

      if (!ObjectId.isValid(userId)) {
        return res.status(400).json({ message: "Invalid user ID format." });
      }

      const user = await usersCollection.findOne(
        { _id: new ObjectId(userId) },
        { projection: { budget: 1 } }
      );

      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }

      const budget = user.budget?.[scheduleId] || user.budget || 0;
      res.json({ budget });
    } catch (err) {
      console.error("Error fetching budget:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  });

  return router;
};
