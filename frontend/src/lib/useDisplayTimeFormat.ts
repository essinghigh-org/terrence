import { useSyncExternalStore } from "react";
import {
  getDisplayTimeFormat,
  subscribeDisplayTimeFormat,
  type DisplayTimeFormat,
} from "./display-time-format";

/** Re-render a component when the operator's display time format changes. */
export function useDisplayTimeFormat(): DisplayTimeFormat {
  return useSyncExternalStore(subscribeDisplayTimeFormat, getDisplayTimeFormat, getDisplayTimeFormat);
}