import { useEffect, useState } from "react";
import { fetchApi } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Switch } from "../components/ui/switch";
import { Card, CardAction, CardContent, CardFooter, CardHeader, CardTitle, CardDescription } from "../components/ui/card";
import { Spinner } from "../components/ui/spinner";
import { CalendarClock, Plus, Trash2 } from "lucide-react";
import { PageHeader, PageShell } from "../components/PageHeader";

type MaintenanceWindow = {
  days: number[];
  "start-time": string;
  "end-time": string;
  timezone?: string;
};

type OperationsSettings = {
  "maintenance-windows"?: {
    enabled?: boolean;
    windows?: MaintenanceWindow[];
  };
};

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_OPTIONS = DAY_LABELS.map((label, index): { day: number; label: string } => ({ day: index, label }));
const DAYS_WEEKDAYS = [1, 2, 3, 4, 5];
const DAYS_WEEKEND = [0, 6];

function humanizeDays(days: number[]): string {
  if (days.length === 0) return "Never";
  if (days.length === 7) return "Every day";
  if (
    days.length === 5
    && DAYS_WEEKDAYS.every((day: number): boolean => days.includes(day))
  ) {
    return "Weekdays";
  }
  if (
    days.length === 2
    && DAYS_WEEKEND.every((day: number): boolean => days.includes(day))
  ) {
    return "Weekend";
  }
  return [...days].sort((a: number, b: number): number => a - b)
    .map((day: number): string => DAY_LABELS[day] ?? String(day))
    .join(", ");
}

function toggleDay(days: number[], day: number): number[] {
  return days.includes(day) ? days.filter((existing: number): boolean => existing !== day) : [...days, day].sort();
}

export function AdminMaintenanceWindows(): React.JSX.Element {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);

  const [windowsEnabled, setWindowsEnabled] = useState(false);
  const [windows, setWindows] = useState<MaintenanceWindow[]>([]);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState("");
  const [saveError, setSaveError] = useState("");

  useEffect((): void => {
    const loadSettings = async (): Promise<void> => {
      setLoading(true);
      setLoadError("");
      try {
        const response = await fetchApi("/admin/operations-settings") as {
          data?: { attributes?: OperationsSettings };
        };
        const attributes = response.data?.attributes ?? {};
        const windowsGroup = attributes["maintenance-windows"] ?? {};
        setWindowsEnabled(windowsGroup.enabled === true);
        setWindows(windowsGroup.windows ?? []);
      } catch (caught: unknown) {
        setLoadError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setLoading(false);
      }
    };
    void loadSettings();
  }, [loadAttempt]);

  const updateWindow = (index: number, patch: Partial<MaintenanceWindow>): void => {
    setWindows((existing): MaintenanceWindow[] => existing.map((window, i): MaintenanceWindow => (i === index ? { ...window, ...patch } : window)));
  };

  const saveMaintenanceWindows = async (): Promise<void> => {
    setSaving(true);
    setSaveError("");
    setSavedAt("");
    try {
      const payload = {
        enabled: windowsEnabled,
        windows: windows.map((window): MaintenanceWindow => ({
          days: [...window.days].sort(),
          "start-time": window["start-time"],
          "end-time": window["end-time"],
          ...(window.timezone !== undefined && window.timezone !== "" ? { timezone: window.timezone } : undefined),
        })),
      };
      await fetchApi("/admin/operations-settings", {
        method: "PATCH",
        body: JSON.stringify({ data: { attributes: { "maintenance-windows": payload } } }),
      });
      setSavedAt(new Date().toLocaleTimeString());
    } catch (caught: unknown) {
      setSaveError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <PageShell role="status" aria-label="Loading maintenance window settings" variant="wide">
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
          <Spinner className="size-6" />
          Loading maintenance window settings…
        </div>
      </PageShell>
    );
  }

  if (loadError !== "") {
    return (
      <PageShell variant="wide">
        <Card>
          <CardContent role="alert" className="flex flex-wrap items-center justify-between gap-3 py-8 text-sm text-destructive">
            <span>{loadError}</span>
            <Button type="button" size="sm" variant="outline" onClick={(): void => { setLoadAttempt((attempt): number => attempt + 1); }} disabled={loading}>
              Try again
            </Button>
          </CardContent>
        </Card>
      </PageShell>
    );
  }

  return (
    <PageShell variant="wide">
      <PageHeader
        eyebrow="Site administration"
        title={(
          <span className="flex items-center gap-2">
            <CalendarClock className="size-7 text-primary" aria-hidden="true" />
            Maintenance windows
          </span>
        )}
        description="Block applies during scheduled maintenance periods. Plans remain available."
      />

      <Card>
        <CardHeader variant="section">
          <CardTitle>Scheduled windows</CardTitle>
          <CardDescription>
            Applies are blocked during configured windows. Plans are never affected.
          </CardDescription>
          <CardAction>
            <div className="flex items-center gap-2">
              <label htmlFor="maintenance-enabled" className="text-xs font-medium text-muted-foreground cursor-pointer">
                {windowsEnabled ? "Enabled" : "Disabled"}
              </label>
              <Switch id="maintenance-enabled" checked={windowsEnabled} onCheckedChange={setWindowsEnabled} aria-label="Maintenance windows" />
            </div>
          </CardAction>
        </CardHeader>
        <CardContent>
          {windows.length === 0 ? (
            <div className="rounded-lg border border-dashed bg-muted/30 px-4 py-8 text-center">
              <p className="text-sm font-medium text-foreground">No maintenance windows yet</p>
              <p className="mt-1 text-sm text-muted-foreground">Add a window when applies need a predictable pause.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {windows.map((window, index): React.JSX.Element => (
                <div key={index} className="rounded-lg border bg-card p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-foreground">Window {index + 1}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:bg-destructive/10"
                      onClick={(): void => { setWindows((existing): MaintenanceWindow[] => existing.filter((_, i): boolean => i !== index)); }}
                      aria-label={`Remove window ${index + 1}`}
                    >
                      <Trash2 className="size-4" aria-hidden="true" />
                    </Button>
                  </div>
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="text-xs font-medium text-foreground">Active days</label>
                      <span className="text-xs font-medium text-muted-foreground">{humanizeDays(window.days)}</span>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {DAY_OPTIONS.map((option): React.JSX.Element => {
                        const selected = window.days.includes(option.day);
                        return (
                          <Button
                            key={option.day}
                            type="button"
                            size="sm"
                            variant={selected ? "default" : "outline"}
                            className="h-7 px-2.5 text-xs font-normal"
                            onClick={(): void => { updateWindow(index, { days: toggleDay(window.days, option.day) }); }}
                          >
                            {option.label}
                          </Button>
                        );
                      })}
                    </div>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <div className="space-y-1">
                      <label htmlFor={`window-${index}-start`} className="text-xs font-medium text-foreground">Start time</label>
                      <Input
                        id={`window-${index}-start`}
                        name={`window-${index}-start-time`}
                        type="time"
                        value={window["start-time"]}
                        onChange={(event): void => { updateWindow(index, { "start-time": event.target.value }); }}
                      />
                    </div>
                    <div className="space-y-1">
                      <label htmlFor={`window-${index}-end`} className="text-xs font-medium text-foreground">End time</label>
                      <Input
                        id={`window-${index}-end`}
                        name={`window-${index}-end-time`}
                        type="time"
                        value={window["end-time"]}
                        onChange={(event): void => { updateWindow(index, { "end-time": event.target.value }); }}
                      />
                    </div>
                    <div className="space-y-1">
                      <label htmlFor={`window-${index}-timezone`} className="text-xs font-medium text-foreground">Timezone</label>
                      <Input
                        id={`window-${index}-timezone`}
                        name={`window-${index}-timezone`}
                        value={window.timezone ?? ""}
                        placeholder="UTC"
                        onChange={(event): void => { updateWindow(index, { timezone: event.target.value }); }}
                      />
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">Times are interpreted in the selected timezone (defaults to UTC).</p>
                </div>
              ))}
            </div>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-4"
            onClick={(): void => {
              setWindows((existing): MaintenanceWindow[] => [
                ...existing,
                { days: [0, 6], "start-time": "00:00", "end-time": "04:00" },
              ]);
            }}
          >
            <Plus data-icon="inline-start" className="size-4" />
            Add maintenance window
          </Button>
        </CardContent>
        <CardFooter className="justify-between">
          <span role="status" className="text-sm">
            {saveError !== "" && <span className="text-destructive">{saveError}</span>}
            {savedAt !== "" && <span className="text-success">Maintenance settings saved at {savedAt}.</span>}
          </span>
          <Button type="button" onClick={(): void => { void saveMaintenanceWindows(); }} disabled={saving}>
            {saving && <Spinner data-icon="inline-start" className="size-4" />}
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </CardFooter>
      </Card>
    </PageShell>
  );
}
