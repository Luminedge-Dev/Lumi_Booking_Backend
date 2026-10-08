import type { CourseRepository } from "../modules/course/course.repository";
import { PrismaCourseRepository } from "../modules/course/course.repository";
import type { AuthRepository } from "../modules/auth/auth.repository";
import { PrismaAuthRepository } from "../modules/auth/auth.repository";
import type { UserRepository } from "../modules/user/user.repository";
import { PrismaUserRepository } from "../modules/user/user.repository";
import type { ScheduleRepository } from "../modules/schedule/schedule.repository";
import { PrismaScheduleRepository } from "../modules/schedule/schedule.repository";

// Stage 15 persistence map (explicitly hybrid):
//   PostgreSQL / Prisma (stage13-dev):  auth, user, course, schedule
//   MongoDB (native driver):            everything else (collections in AppDependencies)
// No operation spans both databases, and no cross-database atomicity exists.
export interface CoreRepositories {
  auth: AuthRepository;
  user: UserRepository;
  course: CourseRepository;
  schedule: ScheduleRepository;
}

// Constructing these never connects: each repository resolves the Prisma
// client on its first query.
export function createCoreRepositories(): CoreRepositories {
  return {
    auth: new PrismaAuthRepository(),
    user: new PrismaUserRepository(),
    course: new PrismaCourseRepository(),
    schedule: new PrismaScheduleRepository(),
  };
}
