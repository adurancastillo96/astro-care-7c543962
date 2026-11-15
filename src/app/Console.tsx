import { MotionConfig } from "motion/react";
import App from "./App";

export default function Console() {
  return (
    <MotionConfig reducedMotion="user">
      <App />
    </MotionConfig>
  );
}
