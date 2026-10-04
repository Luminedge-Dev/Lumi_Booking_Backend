import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { CourseRepository } from "../../../src/app/modules/course/course.repository";
import { CourseService } from "../../../src/app/modules/course/course.service";

class FakeCoursesCollection {
  constructor(private docs: Array<Record<string, unknown>> = []) {}
  find() {
    return { toArray: async () => this.docs };
  }
}

describe("CourseService.listCourses", () => {
  it("returns the mapped course list, ObjectId id included", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const repo = new CourseRepository(new FakeCoursesCollection([{ _id: new ObjectId(), name: "IELTS" }]) as any);
    const service = new CourseService(repo);
    const courses = await service.listCourses();
    assert.equal(courses.length, 1);
    assert.equal(courses[0].name, "IELTS");
  });

  it("empty collection -> empty array", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const repo = new CourseRepository(new FakeCoursesCollection([]) as any);
    const service = new CourseService(repo);
    assert.deepEqual(await service.listCourses(), []);
  });
});
