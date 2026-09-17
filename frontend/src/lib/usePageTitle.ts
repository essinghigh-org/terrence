import { useEffect } from "react";

export function usePageTitle(title?: string): void {
  useEffect((): (() => void) => {
    const defaultTitle = "Terrence | OpenTofu & Terraform Automation";
    if (title !== undefined && title.trim() !== "") {
      document.title = `${title} · Terrence`;
    } else {
      document.title = defaultTitle;
    }
    return (): void => {
      document.title = defaultTitle;
    };
  }, [title]);
}
