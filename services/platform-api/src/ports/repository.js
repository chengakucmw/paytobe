export function createRepositoryPort(repository, requiredMethods = []) {
  if (!repository || typeof repository !== "object") throw new TypeError("Repository is required");
  for (const method of requiredMethods) {
    if (typeof repository[method] !== "function") throw new TypeError(`Repository method is required: ${method}`);
  }
  return Object.freeze({ repository, required_methods: Object.freeze([...requiredMethods]) });
}

export function createTransactionBoundary(run = async (operation) => operation()) {
  if (typeof run !== "function") throw new TypeError("Transaction runner is required");
  return Object.freeze({
    async execute(operation) {
      if (typeof operation !== "function") throw new TypeError("Transaction operation is required");
      return run(operation);
    }
  });
}
