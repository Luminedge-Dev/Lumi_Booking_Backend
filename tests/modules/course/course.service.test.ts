import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CourseService } from "../../../src/app/modules/course/course.service";
import { FakeCourseRepository } from "../../helpers/fake-core-repositories";

const HEX = "6713f7ab0123456789abcdef";

describe("CourseService.listCourses", () => {
  it("returns the mapped course list, string id included", async () => {
    const service = new CourseService(
      new FakeCourseRepository([{ _id: HEX, name: "IELTS", image: "ielts.png", homeBasedSystems: [] }])
    );
    const courses = await service.listCourses();
    assert.equal(courses.length, 1);
    assert.equal(courses[0]._id, HEX);
    assert.equal(courses[0].name, "IELTS");
  });

  it("no rows -> empty array", async () => {
    const service = new CourseService(new FakeCourseRepository([]));
    assert.deepEqual(await service.listCourses(), []);
  });

  it("a repository failure propagates to the caller (controller owns the 500 mapping)", async () => {
    const service = new CourseService({
      findAll: async () => {
        throw new Error("persistence down");
      },
    });
    await assert.rejects(() => service.listCourses(), /persistence down/);
  });
});
