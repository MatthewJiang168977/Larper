import { assertDesignLab } from "../assert-design-lab";
import { WallpaperExport } from "./wallpaper-export";

export default function WallpaperExportPage() {
  assertDesignLab();
  return <WallpaperExport />;
}
