import { expect, test } from "vitest";
import { deleteProject } from "./delete";
import { MemoryProjectStore } from "../../../adapters/memory/site-fixture";
import { MemoryCompatStore } from "../../../adapters/memory/compat";
import type { BucketName } from "../../compat/model";

test("when the project row fails to go, its compat rows are already gone and a retry finishes", async () => {
  const projects = new MemoryProjectStore();
  const compat = new MemoryCompatStore();
  await projects.save({ id: "p1", name: "P", createdAt: 0, updatedAt: 0, ownerId: "u1", workspaceId: "ws1" });
  await compat.insertBucket({ name: "media" as BucketName, projectId: "p1", mount: null, createdAt: 0 });
  const remove = projects.delete.bind(projects);
  projects.delete = async () => { throw new Error("db down"); };

  await expect(deleteProject(projects, compat, "p1")).rejects.toThrow("db down");
  expect(await projects.find("p1")).not.toBeNull();
  expect(await compat.listBuckets("p1")).toEqual([]);

  projects.delete = remove;
  await deleteProject(projects, compat, "p1");
  expect(await projects.find("p1")).toBeNull();
});
