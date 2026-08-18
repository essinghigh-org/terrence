import { useEffect, useState } from "react";
import QRCode from "qrcode";

export function QrCodeImage({
  value,
  className,
}: Readonly<{ value: string; className?: string }>): React.JSX.Element {
  const [dataUrl, setDataUrl] = useState("");
  const [failed, setFailed] = useState(false);

  useEffect((): (() => void) => {
    let cancelled = false;
    QRCode.toDataURL(value, { width: 256, margin: 1, errorCorrectionLevel: "M" })
      .then((url: string): void => {
        if (!cancelled) setDataUrl(url);
      })
      .catch((): void => {
        if (!cancelled) setFailed(true);
      });
    return (): void => {
      cancelled = true;
    };
  }, [value]);
  if (failed) {
    return <p className="text-xs text-muted-foreground">Could not render QR code.</p>;
  }
  if (dataUrl === "") {
    return <div className="size-64 animate-pulse rounded-md bg-muted" aria-label="Loading QR code" />;
  }
  return <img src={dataUrl} alt="Authenticator setup QR code" width={256} height={256} className={className} />;
}