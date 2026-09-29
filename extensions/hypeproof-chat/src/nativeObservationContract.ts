// hps-observation/1 (App side). No logic lives here any more (#1042).
// The App and the Service import the one host-independent implementation in the
// common measurement core; worker/test/measurement-core.test.mjs locks that both
// import paths resolve to the same function objects.
export * from "../../../worker/src/lib/measurement-core/legacy-observation.ts";
