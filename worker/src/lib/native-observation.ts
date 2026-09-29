// hps-observation/1 (Service side). No logic lives here any more (#1042).
// Existing Service imports keep this path; the implementation is the common
// measurement core, shared with the App (see measurement-core/index.ts).
export * from "./measurement-core/legacy-observation.ts";
