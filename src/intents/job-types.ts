/** `job_type` values accepted by GET /api/v1/jobs (the TDEI Portal "Job Type" filter, spelled the API's way). */
export const JOB_TYPES = [
  "Clone-Dataset",
  "Confidence-Calculate",
  "Dataset-BBox",
  "Dataset-Incline-Tag",
  "Dataset-Publish",
  "Dataset-Reformat",
  "Dataset-Road-Tag",
  "Dataset-Spatial-Join",
  "Dataset-Union",
  "Dataset-Upload",
  "Dataset-Validate",
  "Edit-Metadata",
  "Quality-Metric",
  "Quality-Report",
] as const;

export type JobType = (typeof JOB_TYPES)[number];

const squash = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Portal labels and common wordings that do not match the API value once squashed. */
const ALIASES: Readonly<Record<string, JobType>> = {
  filterdatasetbybbox: "Dataset-BBox",
  filterbybbox: "Dataset-BBox",
  bbox: "Dataset-BBox",
  cutbbox: "Dataset-BBox",
  confidence: "Confidence-Calculate",
  confidencecalculation: "Confidence-Calculate",
  validate: "Dataset-Validate",
  validation: "Dataset-Validate",
  upload: "Dataset-Upload",
  publish: "Dataset-Publish",
  reformat: "Dataset-Reformat",
  convert: "Dataset-Reformat",
  conversion: "Dataset-Reformat",
  union: "Dataset-Union",
  spatialjoin: "Dataset-Spatial-Join",
  roadtag: "Dataset-Road-Tag",
  inclinetag: "Dataset-Incline-Tag",
  clone: "Clone-Dataset",
  clonedataset: "Clone-Dataset",
  editmetadata: "Edit-Metadata",
  qualitymetrictag: "Quality-Metric",
  qualitymetricixncalculation: "Quality-Metric",
  qualitymetricixn: "Quality-Metric",
  qualityreport: "Quality-Report",
};

const CANONICAL = new Map<string, JobType>(JOB_TYPES.map((type) => [squash(type), type]));

/** Map a portal label, alias or API value to the API `job_type`; undefined when it is not a known job type. */
export function normalizeJobType(raw: string): JobType | undefined {
  const key = squash(raw);
  return CANONICAL.get(key) ?? ALIASES[key];
}
