import { LoadingState } from "@/components/shared/loading-state";
import { PageContainer } from "@/components/shared/page-container";

export default function RootLoading(): React.ReactElement {
  return (
    <PageContainer>
      <LoadingState fullScreen message="Loading..." />
    </PageContainer>
  );
}
