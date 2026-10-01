import type { Db } from "mongodb";
import type { AppCollections } from "./database.types";

export function createCollections(db: Db): AppCollections {
  return {
    usersCollection: db.collection("users"),
    coursesCollection: db.collection("courses"),
    schedulesCollection: db.collection("schedules"),
    bookingMockCollection: db.collection("bookingMock"),
  };
}
