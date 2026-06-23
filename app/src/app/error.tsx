"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { ErrorAlert } from "@/components/shared/error-alert";
import { InlineActions } from "@/components/shared/inline-actions";
import { PageContainer } from "@/components/shared/page-container";
import { PageHeader } from "@/components/shared/page-header";

export default function RootError({
  error,
  reset,
}: {
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
}): React.ReactElement {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <PageContainer>
      <PageHeader
        title="Something broke"
        description="The app hit an unexpected error while rendering this page."
        actions={
          <InlineActions>
            <Button variant="outline" onClick={reset}>
              Retry
            </Button>
          </InlineActions>
        }
      />
      <ErrorAlert message={error.message} />
    </PageContainer>
  );
}
