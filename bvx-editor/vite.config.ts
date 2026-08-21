import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
    plugins: [react()],
    server: {
        port: 5180
    },
    build: {
        // BabylonJS is a large dependency - raise the warning threshold
        chunkSizeWarningLimit: 4096
    }
});
