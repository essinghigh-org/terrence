import { useEffect, useState } from "react";
import { fetchApi } from "@/lib/api";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Link } from "react-router-dom";

export function Dashboard() {
  const [orgs, setOrgs] = useState<any[]>([]);

  useEffect(() => {
    fetchApi("/organizations").then(data => setOrgs(data.data)).catch(console.error);
  }, []);

  return (
    <div className="p-8 max-w-4xl mx-auto space-y-6">
      <h1 className="text-3xl font-bold">Organizations</h1>
      <div className="grid gap-4 md:grid-cols-2">
        {orgs.map(org => (
          <Link key={org.id} to={`/app/${org.attributes.name}`}>
            <Card className="hover:shadow-md transition-shadow">
              <CardHeader>
                <CardTitle>{org.attributes.name}</CardTitle>
              </CardHeader>
            </Card>
          </Link>
        ))}
        {orgs.length === 0 && (
          <div className="text-gray-500">No organizations found.</div>
        )}
      </div>
    </div>
  );
}
