import { mountBrowserCompanionApp } from "../app";
import "../styles.css";

const root = document.getElementById("app");

if (!root) {
  throw new Error("Side panel root element not found.");
}

mountBrowserCompanionApp(root, "sidepanel");
