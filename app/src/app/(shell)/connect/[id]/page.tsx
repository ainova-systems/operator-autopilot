import { redirect } from "next/navigation";
import { setActiveConnection } from "@/lib/connections";

interface RouteProps {
  readonly params: Promise<{ readonly id: string }>;
}

/**
 * Connection switcher. Left-rail links point here; the page is a
 * server-side no-UI redirect that sets the active connection and sends
 * the user to the work-items view for the newly active instance.
 */
export default async function ConnectPage({ params }: RouteProps): Promise<never> {
  const { id } = await params;
  await setActiveConnection(id);
  redirect("/work-items");
}
