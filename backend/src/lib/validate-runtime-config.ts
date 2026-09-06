import { initializeRuntimeConfiguration } from "./runtime-config";

// Import this before the database, logging transports, or worker modules.
initializeRuntimeConfiguration();
