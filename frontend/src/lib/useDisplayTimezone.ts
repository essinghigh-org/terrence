import { useSyncExternalStore } from "react";
import {
  getDisplayTimezone,
  subscribeDisplayTimezone,
  type DisplayTimezone,
} from "./display-timezone";

/** Re-render a component when the operator's display timezone changes. */
export function useDisplayTimezone(): DisplayTimezone {
  return useSyncExternalStore(subscribeDisplayTimezone, getDisplayTimezone, getDisplayTimezone);
}
