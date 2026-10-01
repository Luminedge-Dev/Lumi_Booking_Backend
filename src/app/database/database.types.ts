import type { Collection, Document, MongoClient } from "mongodb";

export interface AppCollections {
  usersCollection: Collection<Document>;
  coursesCollection: Collection<Document>;
  schedulesCollection: Collection<Document>;
  bookingMockCollection: Collection<Document>;
}

export interface AppDependencies extends AppCollections {
  client: MongoClient;
}
