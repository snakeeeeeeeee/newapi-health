import { NextResponse } from "next/server";

import { getHealthSnapshot } from "@/lib/monitor/store";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  const snapshot = await getHealthSnapshot();
  return NextResponse.json(snapshot);
}
