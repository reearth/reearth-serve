import type { ArchiveFormat, AssetStatus, FailureClass, Job } from "../../shared/api";

const FAILURE_CLASS: Record<Job["type"], Record<ArchiveFormat, FailureClass>> = {
  "archive-extraction": {
    zip: "slower-reads",
    tar: "missing-feature",
    "tar.gz": "missing-feature",
    "tar.bz2": "missing-feature",
  },
};

const MIRROR_STATUS_ON_FAILURE: Record<FailureClass, AssetStatus> = {
  "missing-feature": "failed",
  "slower-reads": "ready",
  "rejected-version": "failed",
};

export function failureClassOf(type: Job["type"], archiveFormat: ArchiveFormat | undefined): FailureClass {
  return archiveFormat ? FAILURE_CLASS[type][archiveFormat] : "missing-feature";
}

interface Mirror {
  status?: AssetStatus;
  archiveFormat?: ArchiveFormat;
}

export function classify(job: Job, mirror: Mirror | null): FailureClass | undefined {
  if (mirror) job.failureClass ??= failureClassOf(job.type, mirror.archiveFormat);
  return job.failureClass;
}

export function failMirror(job: Job, mirror: Mirror | null, reason: string): void {
  const failureClass = classify(job, mirror);
  if (mirror && failureClass) mirror.status = MIRROR_STATUS_ON_FAILURE[failureClass];
  console.log(`job ${job.id} (asset ${job.assetId}) failed, failure class ${failureClass ?? "unknown"}: ${reason}`);
}

if (import.meta.vitest) {
  const { describe, expect, test } = import.meta.vitest;

  describe("failureClassOf", () => {
    test("a zip extraction only slows reads, the tar family loses a feature", () => {
      expect(failureClassOf("archive-extraction", "zip")).toBe("slower-reads");
      for (const format of ["tar", "tar.gz", "tar.bz2"] as const) {
        expect(failureClassOf("archive-extraction", format)).toBe("missing-feature");
      }
    });

    test.each([undefined, "ZIP", "rar", "zip ", "constructor", "toString", "__proto__"])(
      "an unknown format %j is treated as a missing feature",
      (format) => {
        expect(failureClassOf("archive-extraction", format as ArchiveFormat | undefined)).toBe("missing-feature");
      },
    );
  });

  describe("failMirror", () => {
    const job = { id: "j1", assetId: "a1", type: "archive-extraction", status: "running", createdAt: 0, updatedAt: 0 } as Job;
    const failedMirror = (archiveFormat: string) => {
      const mirror: Mirror = { status: "extracting", archiveFormat: archiveFormat as ArchiveFormat };
      failMirror({ ...job }, mirror, "boom");
      return mirror.status;
    };

    test("a zip mirror stays ready", () => {
      expect(failedMirror("zip")).toBe("ready");
    });

    test.each(["tar.gz", "rar", "__proto__", "constructor"])("a %j mirror is failed", (format) => {
      expect(failedMirror(format)).toBe("failed");
    });

    test("no mirror is not an error", () => {
      expect(() => failMirror({ ...job }, null, "boom")).not.toThrow();
    });
  });
}
