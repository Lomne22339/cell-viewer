// The adapter for the separate chatbot service lives in core so it can be
// tested in plain Node. The Protocol creator's Recipe Maker uses it when the
// server reports the service ready; the dashboard chat does not (it needs the
// selection, which the service cannot carry).
export { ServiceAdapter, describeStatus } from '@core/chat/service';
export type { ChatbotStatus } from '@core/chat/service';
