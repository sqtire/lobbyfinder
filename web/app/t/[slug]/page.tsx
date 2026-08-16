import TournamentDashboard from "@/components/TournamentDashboard";

export const dynamic = "force-dynamic";

export default function Page({ params }: { params: { slug: string } }) {
  return <TournamentDashboard slug={params.slug} />;
}
