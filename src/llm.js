export function createDjAgent() {
  return {
    async processGuestMessage(message, context) {
      return {
        reply: "LLM integration is not connected yet.",
        actions: [],
        message,
        context,
      };
    },
  };
}