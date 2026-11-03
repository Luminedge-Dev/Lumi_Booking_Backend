const { Router } = require("express");
const { ObjectId } = require("mongodb");
const { verifyToken, verifyAdmin, verifyStaff, ownerOrStaff } = require("../middleware/auth");
const { bookingFrozen } = require("../middleware/frozen");

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
            $convert: {
              input: "$timeSlots.slotId",
              to: "int",
              onError: 0,
              onNull: 0,
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

  router.post("/admin/create-schedule", bookingFrozen, verifyAdmin, async (req, res) => {
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

  const IELTS_BASE_ID = "67337c880794d577cd982b75";
  const IELTS_CD_ID = "6742b783d2f5950620f6df21";

  const buildCourseIdQueryValues = (courseId) => {
    const raw = String(courseId || "").trim();
    const set = new Set([raw]);
    if (raw === IELTS_BASE_ID || raw === IELTS_CD_ID) {
      set.add(IELTS_BASE_ID);
      set.add(IELTS_CD_ID);
    }
    const values = [];
    for (const id of set) {
      if (id) {
        values.push(id);
        if (ObjectId.isValid(id)) {
          values.push(new ObjectId(id));
        }
      }
    }
    return values;
  };

  // Get monthly schedule availability for course (calendar highlighting)
  router.get("/schedule/course/:courseId", verifyToken, async (req, res) => {
    try {
      const { courseId } = req.params;
      const { month } = req.query;

      const courseValues = buildCourseIdQueryValues(courseId);
      const match = {
        courseId: { $in: courseValues },
        status: { $nin: ["Cancelled", "cancelled", "CANCELLED"] },
      };

      if (month && /^\d{4}-\d{2}$/.test(String(month).trim())) {
        const m = String(month).trim();
        match.$or = [
          { startDate: { $regex: `^${m}` } },
          {
            $and: [
              { startDate: { $lte: `${m}-31` } },
              { endDate: { $gte: `${m}-01` } },
            ],
          },
        ];
      }

      const schedules = await schedulesCollection
        .find(match, {
          projection: {
            _id: 1,
            courseId: 1,
            name: 1,
            testType: 1,
            testSystem: 1,
            startDate: 1,
            endDate: 1,
            status: 1,
            venue: 1,
            timeSlots: 1,
          },
        })
        .toArray();

      res.json({ success: true, schedules });
    } catch (e) {
      console.error("schedule by course error:", e);
      res.status(500).json({ success: false, message: "Failed to load course schedules" });
    }
  });

  // Get schedule by date + courseId
  router.get("/schedule/:date/:courseId", verifyToken, async (req, res) => {
    try {
      const { date, courseId } = req.params;
      const courseValues = buildCourseIdQueryValues(courseId);

      const matchClause = {
        courseId: { $in: courseValues },
        status: { $nin: ["Cancelled", "cancelled", "CANCELLED"] },
        $or: [
          { startDate: date },
          { startDate: { $regex: `^${date}` } },
          {
            $and: [
              { startDate: { $lte: date } },
              { endDate: { $gte: date } },
            ],
          },
        ],
      };

      const schedules = await schedulesCollection
        .aggregate([
          { $match: matchClause },
          {
            $addFields: {
              _slotIdNum: {
                $cond: [
                  { $gt: [{ $size: { $ifNull: ["$timeSlots", []] } }, 0] },
                  {
                    $convert: {
                      input: { $arrayElemAt: ["$timeSlots.slotId", 0] },
                      to: "int",
                      onError: 0,
                      onNull: 0,
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

  // Get schedules by userId.
  //
  // R01 (29 Oct 2026 corrective slice): this route used `verifyToken` alone, so
  // any authenticated caller could ask for an arbitrary `userId`'s schedules.
  // Evidence gathered before changing it: no current writer ever puts `userId`
  // on a schedule document (`/admin/create-schedule` inserts courseId/dates/
  // slots only, and booking updates only decrement slot counters), and no
  // frontend page requests this path — so this is a legacy/historical read, not
  // an actively exercised one. It stays protected anyway: authorisation is now
  // owner-or-staff, which keeps historical per-student rows readable by their
  // owner and by staff, and returns 403 to everyone else. The `{ schedules }`
  // response contract is unchanged, and the date/course discovery route below
  // (different arity) is untouched.
  router.get("/schedule/:userId", ownerOrStaff("userId"), async (req, res) => {
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
