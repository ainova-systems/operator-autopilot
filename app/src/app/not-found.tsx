import Link from "next/link";
import { FileQuestion } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/shared/empty-state";
import { PageContainer } from "@/components/shared/page-container";

export default function NotFound(): React.ReactElement {
  return (
    <PageContainer>
      <EmptyState
        icon={FileQuestion}
        title="Page not found"
        description="The page you were looking for does not exist or has moved."
      >
        <Link href="/">
          <Button variant="outline" className="mt-2">
            Go to dashboard
          </Button>
        </Link>
      </EmptyState>
    </PageContainer>
  );
}
