// Single source of truth for the 19 indexes used both by index.js's runtime
// ensureIndexes() and the standalone scripts/ensure-indexes.js migration
// script, so the two can never silently drift apart. Declarative (collection
// + key spec) rather than just a list of closures, so the migration script
// can also verify these against listIndexes() after creation, not just
// assume createIndex() not throwing means the index exists as intended.
//
// Order matches the original runtime execution order exactly (not grouped
// by collection) — preserved as-is rather than reordered, since nothing
// depends on grouping and changing it isn't part of this fix.
const INDEX_SPECS = [
  { collection: "users", key: { email: 1 }, options: { unique: true } },
  { collection: "users", key: { status: 1 } },
  { collection: "users", key: { role: 1 } },
  { collection: "users", key: { createdAt: -1 } },
  { collection: "users", key: { "mocks.mrValidationExpiry": 1 } },
  { collection: "users", key: { profileChangeRequestStatus: 1 } },
  { collection: "bookingMock", key: { userId: 1 } },
  { collection: "bookingMock", key: { scheduleId: 1 } },
  { collection: "bookingMock", key: { location: 1 } },
  { collection: "bookingMock", key: { bookingDate: 1 } },
  { collection: "bookingMock", key: { attendance: 1 } },
  { collection: "bookingMock", key: { userId: 1, scheduleId: 1 } },
  { collection: "bookingMock", key: { userId: 1, location: 1 } },
  { collection: "bookingMock", key: { userId: 1, bookingDate: -1 } },
  { collection: "schedules", key: { courseId: 1, startDate: 1, endDate: 1 } },
  { collection: "schedules", key: { startDate: 1 } },
  { collection: "users", key: { nameLower: 1 } },
  { collection: "users", key: { emailLower: 1 } },
  { collection: "reminderDeliveries", key: { scheduleId: 1, userId: 1 }, options: { unique: true, name: "uniq_reminder_schedule_user" } },
];

function getIndexOps({ usersCollection, bookingMockCollection, schedulesCollection, reminderDeliveriesCollection }) {
  const collectionsByName = {
    users: usersCollection,
    bookingMock: bookingMockCollection,
    schedules: schedulesCollection,
    reminderDeliveries: reminderDeliveriesCollection,
  };
  return INDEX_SPECS.map(({ collection, key, options }) => {
    const target = collectionsByName[collection];
    if (!target) {
      throw new Error(
        `Unknown collection "${collection}" in INDEX_SPECS — expected one of: ${Object.keys(collectionsByName).join(", ")}`
      );
    }
    return () => target.createIndex(key, options);
  });
}

module.exports = { getIndexOps, INDEX_SPECS };
