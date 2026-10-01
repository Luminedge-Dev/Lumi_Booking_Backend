import type { CreateIndexesOptions, IndexSpecification } from "mongodb";
import type { AppCollections } from "./database.types";

// Reproduced verbatim from config/indexDefinitions.js (order, keys, and options
// copied 1:1 — do not reorder, add, or remove entries during this parity
// conversion). The original file remains the single source of truth for the
// legacy runtime; this is an independent TypeScript copy for the new runtime path.
interface IndexSpec {
  collection: "users" | "bookingMock" | "schedules";
  key: IndexSpecification;
  options?: CreateIndexesOptions;
}

const INDEX_SPECS: IndexSpec[] = [
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
];

export function getIndexOps(collections: AppCollections): Array<() => Promise<string>> {
  const collectionsByName = {
    users: collections.usersCollection,
    bookingMock: collections.bookingMockCollection,
    schedules: collections.schedulesCollection,
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

export { INDEX_SPECS };
