import { mountBrowserCompanionApp } from "../app";
import "../styles.css";

const root = document.getElementById("app");

if (!root) {
  throw new Error("Popup root element not found.");
}

mountBrowserCompanionApp(root, "popup");
