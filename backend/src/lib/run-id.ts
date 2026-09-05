import { newResourceId } from "./resource-id";

export const RUN_ID_LENGTH = 18;

export function newRunId(): string {
  return newResourceId("run");
}
