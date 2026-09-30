const { Router } = require("express");
const { ObjectId } = require("mongodb");
const { verifyToken, verifyAdmin, verifyStaff } = require("../middleware/auth");

const router = Router();

const pad2 = (n) => String(n).padStart(2, "0");
const toHHMM = (v) => {
  const [h = "0", m = "0"] = String(v || "").split(":");
  return `${pad2(+h)}:${pad2(+m)}`;
};
const toHHMMSS = (v) => {
  const [h = "0", m = "0", s = "0"] = String(v || "").split(":");
  return `${pad2(+h)}:${pad2(+m)}:${pad2(+s)}`;
};
const normalizeIncomingSlot = (slot) => {
  const s = toHHMM(slot.startTime);
  const e = toHHMM(slot.endTime);
  return {
    startTime: toHHMMSS(s),
    endTime: toHHMMSS(e),
    slot: Number(slot.slot ?? 0),
    totalSlot: Number(slot.totalSlot ?? slot.slot ?? 0),
  };
};

async function getMaxSlotIdAcrossDocs(col, key) {
  const [row] = await col
    .aggregate([
      { $match: key },
      { $unwind: "$timeSlots" },
      {
        $project: {
          n: {
            $toInt: {
              $ifNull: [
                {
                  $cond: [
                    { $isNumber: "$timeSlots.slotId" },
                    "$timeSlots.slotId",
                    { $toInt: { $ifNull: ["$timeSlots.slotId", 0] } },
                  ],
                },
                0,
              ],
            },
          },
        },
      },
      { $group: { _id: null, maxId: { $max: "$n" } } },
      { $project: { _id: 0, maxId: 1 } },
    ], { maxTimeMS: 5000 })
    .toArray();

  return row?.maxId || 0;
}

module.exports = ({ schedulesCollection, coursesCollection }) => {
  // Public — users need courses list to book
  router.get("/courses", async (req, res) => {
    try {
      const courses = await coursesCollection.find({}).toArray();
      res.json({ courses });
    } catch (err) {
      console.error("Error fetching courses:", err);
      res.status(500).json({ message: "Failed to load courses." });
    }
  });

  router.post("/admin/create-schedule", verifyAdmin, async (req, res) => {
    const payload = Array.isArray(req.body) ? req.body : [];
    const successful = [];
    const failed = [];
    const nowIso = new Date().toISOString();

    try {
      for (const incoming of payload) {
        const { courseId, startDate, endDate, testType } = incoming || {};
        if (!courseId || !startDate || !endDate) {
          failed.push({ courseId: courseId || "", startDate: startDate || "", endDate: endDate || "", message: "Missing courseId/startDate/endDate", timestamp: nowIso });
          continue;
        }

        const key = { courseId, startDate, endDate, testType };
        let nextId = await getMaxSlotIdAcrossDocs(schedulesCollection, key);

        const incomingSlots = Array.isArray(incoming.timeSlots)
          ? incoming.timeSlots.map(normalizeIncomingSlot)
          : [];

        if (!incomingSlots.length) {
          failed.push({ courseId, startDate, endDate, message: "No time slots provided.", timestamp: nowIso });
          continue;
        }

        for (const s of incomingSlots) {
          nextId += 1;
          const doc = {
            courseId, startDate, endDate,
            name: incoming.name ?? "",
            testSystem: incoming.testSystem ?? "",
            testType: testType ?? "",
            status: incoming.status ?? "Scheduled",
            timeSlots: [{ ...s, slotId: String(nextId) }],
            createdAt: nowIso,
          };
          await schedulesCollection.insertOne(doc);
          successful.push({ courseId, startDate, endDate, assignedSlotId: String(nextId), createdAt: nowIso });
        }
      }

      if (!successful.length) {
        return res.status(409).json({ success: false, message: "No schedules created.", successfulSchedules: successful, failedSchedules: failed });
      }
      return res.status(failed.length ? 207 : 201).json({
        success: true,
        message: failed.length ? "Schedules created (some skipped)." : "Schedules created successfully.",
        successfulSchedules: successful,
        failedSchedules: failed,
      });
    } catch (err) {
      console.error("create-schedule error:", err);
      return res.status(500).json({ success: false, message: "Server error while creating schedules" });
    }
  });

  // Get schedule by date + courseId
  router.get("/schedule/:date/:courseId", verifyToken, async (req, res) => {
    try {
      const { date, courseId } = req.params;
      const schedules = await schedulesCollection
        .aggregate([
          { $match: { courseId, startDate: date, endDate: date, status: { $ne: "Cancelled" } } },
          {
            $addFields: {
              _slotIdNum: {
                $cond: [
                  { $gt: [{ $size: "$timeSlots" }, 0] },
                  {
                    $toInt: {
                      $ifNull: [
                        {
                          $cond: [
                            { $isNumber: { $arrayElemAt: ["$timeSlots.slotId", 0] } },
                            { $arrayElemAt: ["$timeSlots.slotId", 0] },
                            { $toInt: { $arrayElemAt: ["$timeSlots.slotId", 0] } },
                          ],
                        },
                        0,
                      ],
                    },
                  },
                  0,
                ],
              },
            },
          },
          { $sort: { _slotIdNum: 1, startDate: 1, _id: 1 } },
          { $project: { _slotIdNum: 0 } },
        ], { maxTimeMS: 8000 })
        .toArray();
      res.json({ schedules });
    } catch (e) {
      console.error("schedule by date error:", e);
      res.status(500).json({ message: "Failed to load schedules" });
    }
  });

  // Get schedules by userId
  router.get("/schedule/:userId", verifyToken, async (req, res) => {
    const { userId } = req.params;
    try {
      const schedules = await schedulesCollection.find({ userId }).toArray();
      res.json({ schedules });
    } catch (err) {
      console.error("Error fetching schedules by userId:", err);
      res.status(500).json({ message: "Failed to load schedules." });
    }
  });

  // Admin: Get all schedules — paginated
  router.get("/admin/get-schedules", verifyStaff, async (req, res, next) => {
    try {
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
      const skip = (page - 1) * limit;

      const q = {};
      if (req.query.courseId) q.courseId = String(req.query.courseId);
      if (req.query.status) q.status = String(req.query.status);

      const [schedules, total] = await Promise.all([
        schedulesCollection
          .find(q)
          .sort({ _id: -1 })
          .skip(skip)
          .limit(limit)
          .maxTimeMS(8000)
          .toArray(),
        schedulesCollection.countDocuments(q, { maxTimeMS: 3000 }),
      ]);

      res.json({ schedules, total, page, limit });
    } catch (err) {
      if (err?.code === 50) {
        return res.status(504).json({ message: "Query timed out." });
      }
      next(err);
    }
  });

  // Admin: Delete schedule
  router.delete("/admin/delete-schedule/:id", verifyAdmin, async (req, res) => {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid schedule ID format." });
    }

    try {
      const result = await schedulesCollection.deleteOne({ _id: new ObjectId(id) });
      if (result.deletedCount === 0) {
        return res.status(404).json({ message: "Schedule not found" });
      }
      res.json({ success: true, message: "Schedule deleted successfully" });
    } catch (error) {
      console.error("Error deleting schedule:", error);
      res.status(500).json({ message: "Error deleting schedule" });
    }
  });

  return router;
};
