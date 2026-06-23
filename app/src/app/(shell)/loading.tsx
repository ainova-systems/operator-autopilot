import { LoadingState } from "@/components/shared/loading-state";
import { PageContainer } from "@/components/shared/page-container";

export default function ShellLoading(): React.ReactElement {
  return (
    <PageContainer>
      <LoadingState />
    </PageContainer>
  );
}
