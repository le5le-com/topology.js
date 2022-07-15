import { Topology } from "@topology/core";

declare global {
  interface Window {
    topology: Topology;
  }
}

export {}