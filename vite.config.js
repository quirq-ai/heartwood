import { defineConfig } from 'vite';

export default defineConfig({
    // relative asset paths, so the build works from any folder or sub-path of a static host
    base: './',
    server: {
        host: '127.0.0.1',
        port: 5262,
        strictPort: true
    },
    preview: {
        host: '127.0.0.1',
        port: 5263,
        strictPort: true
    },
    build: {
        target: 'es2022',
        chunkSizeWarningLimit: 4000
    }
});
