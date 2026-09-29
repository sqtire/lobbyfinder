import type { Metadata } from "next";
import PlacementsPanel from "@/components/PlacementsPanel";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Final placements — MP Pool Scanner" };

export default function Page() {
  return <PlacementsPanel />;
}
