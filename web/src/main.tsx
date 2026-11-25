import React from "react";
import { createRoot } from "react-dom/client";
import { Dashboard } from "./shell";
import "./styles.css";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Missing #root");
createRoot(rootElement).render(
  <React.StrictMode>
    <Dashboard />
  </React.StrictMode>,
);
