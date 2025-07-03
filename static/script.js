document.addEventListener('DOMContentLoaded', () => {
    // --- Element Cache ---
    const gridContainer = document.getElementById('grid-container');
    const canvasElements = {
        tl: document.getElementById('canvas-tl'),
        tr: document.getElementById('canvas-tr'),
        bl: document.getElementById('canvas-bl'),
        br: document.getElementById('canvas-br'),
    };
    const ctx = {
        tl: canvasElements.tl.getContext('2d'),
        tr: canvasElements.tr.getContext('2d'),
        bl: canvasElements.bl.getContext('2d'),
        br: canvasElements.br.getContext('2d'),
    };
    const prevBtn = document.getElementById('prev-set-btn');
    const nextBtn = document.getElementById('next-set-btn');
    const setInfo = document.getElementById('set-info');
    const loadingIndicator = document.getElementById('loading-indicator');

    // --- Constants ---
    const ZOOM_FACTOR_STEP = 1.2;
    const MIN_NORMALIZED_HEIGHT = 0.001;
    const MAX_NORMALIZED_HEIGHT = 1.0;

    // --- State ---
    let availableSets = [];
    let currentSetIndex = -1;
    let viewState = {
        centerX: 0.5, // Normalized center X (0.0 to 1.0)
        centerY: 0.5, // Normalized center Y (0.0 to 1.0)
        zoom: 1.0,    // Normalized height (1.0 = full image height fits view)
    };
    let isDragging = false;
    let dragStart = { x: 0, y: 0 };
    let dragStartViewCenter = { x: 0, y: 0 };

    // --- Image Loading State ---
    let currentLoadController = null; // AbortController for active loads
    let currentImages = { tl: null, tr: null, bl: null, br: null }; // Holds Image objects
    let imageDimensions = { tl: null, tr: null, bl: null, br: null }; // Holds full-res dimensions

    // --- Utility Functions ---
    function clamp(value, min, max) {
        return Math.min(Math.max(value, min), max);
    }

    function throttle(func, limit) {
        let inThrottle;
        return function() {
            const args = arguments;
            const context = this;
            if (!inThrottle) {
                func.apply(context, args);
                inThrottle = true;
                setTimeout(() => inThrottle = false, limit);
            }
        }
    }
    const throttledDrawView = throttle(drawView, 16); // ~60fps

    // --- Core Drawing Function ---
    function drawView() {
        Object.keys(canvasElements).forEach(key => {
            const canvas = canvasElements[key];
            const context = ctx[key];
            const img = currentImages[key];
            const imgDim = imageDimensions[key];

            // Clear canvas first
            context.clearRect(0, 0, canvas.width, canvas.height);

            // Draw a placeholder if image is missing or has no dimensions
            if (!img || !imgDim || imgDim.width <= 0 || imgDim.height <= 0) {
                context.fillStyle = '#e0e0e0';
                context.fillRect(0, 0, canvas.width, canvas.height);
                context.fillStyle = '#999';
                context.font = '16px sans-serif';
                context.textAlign = 'center';
                // Use a more descriptive text based on state
                context.fillText(img ? 'Processing...' : 'Loading...', canvas.width / 2, canvas.height / 2);
                return;
            }

            // Use nearest-neighbor for sharp pixels when zoomed
            context.imageSmoothingEnabled = false;

            const canvasAspect = canvas.width / canvas.height;
            let zoom = viewState.zoom;

            let sh = imgDim.height * zoom;
            let sw = sh * canvasAspect;

            if (sw > imgDim.width) {
                sw = imgDim.width;
                sh = sw / canvasAspect;
            }
            if (sh > imgDim.height) {
                sh = imgDim.height;
                sw = sh * canvasAspect;
            }

            let sx = viewState.centerX * imgDim.width - sw / 2;
            let sy = viewState.centerY * imgDim.height - sh / 2;

            sx = clamp(sx, 0, imgDim.width - sw);
            sy = clamp(sy, 0, imgDim.height - sh);

            try {
                context.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
            } catch (e) {
                console.error(`Error drawing image ${key}:`, e);
            }
        });
    }

    // --- Image Loading ---
    function loadImage(url, signal) {
        return new Promise((resolve, reject) => {
            fetch(url, { signal })
                .then(response => {
                    if (!response.ok) throw new Error(`HTTP error! status: ${response.status} for ${url}`);
                    return response.blob();
                })
                .then(blob => {
                    const img = new Image();
                    const objectURL = URL.createObjectURL(blob);
                    img.onload = () => {
                        URL.revokeObjectURL(objectURL);
                        resolve(img);
                    };
                    img.onerror = () => {
                        URL.revokeObjectURL(objectURL);
                        reject(new Error(`Image.onerror for ${url}`));
                    };
                    img.src = objectURL;
                })
                .catch(err => {
                    if (err.name !== 'AbortError') {
                        reject(err);
                    }
                });
        });
    }

    async function loadSet(setNumber) {
        if (currentLoadController) {
            currentLoadController.abort();
        }
        currentLoadController = new AbortController();
        const { signal } = currentLoadController;

        setInfo.textContent = `Set: ${setNumber} (...)`;
        loadingIndicator.style.display = 'inline';
        gridContainer.style.cursor = 'wait';

        viewState = { centerX: 0.5, centerY: 0.5, zoom: 1.0 };
        Object.keys(currentImages).forEach(key => {
            currentImages[key] = null;
            imageDimensions[key] = null;
        });
        drawView(); // Show "Loading..." text

        try {
            const urlsResponse = await fetch(`/api/image-urls/${setNumber}`, { signal });
            if (!urlsResponse.ok) throw new Error(`URL fetch failed: ${urlsResponse.status}`);
            const fullResUrls = await urlsResponse.json();

            setInfo.textContent = `Set: ${setNumber} (${currentSetIndex + 1}/${availableSets.length})`;

            const loadPromises = Object.keys(fullResUrls).map(async (key) => {
                try {
                    // a) Load low-res preview
                    const previewUrl = `/api/image-preview/${setNumber}/${key}`;
                    const previewImg = await loadImage(previewUrl, signal);
                    if (signal.aborted) return;

                    // Immediately draw the preview using its own dimensions.
                    currentImages[key] = previewImg;
                    imageDimensions[key] = { width: previewImg.naturalWidth, height: previewImg.naturalHeight };
                    drawView();

                    // b) Load full-res image in the background
                    const fullResImg = await loadImage(fullResUrls[key], signal);
                    if (signal.aborted) return;

                    // c) Once full-res is loaded, update image and its true dimensions, then redraw.
                    currentImages[key] = fullResImg;
                    imageDimensions[key] = { width: fullResImg.naturalWidth, height: fullResImg.naturalHeight };
                    drawView();
                } catch (error) {
                    if (error && error.name !== 'AbortError') {
                        console.error(`Failed to load image for ${key} in set ${setNumber}:`, error);
                        imageDimensions[key] = {width: 1, height: 1};
                        drawView(); // Redraw to show error state
                    }
                }
            });

            Promise.allSettled(loadPromises).finally(() => {
                if (!signal.aborted) {
                    loadingIndicator.style.display = 'none';
                    gridContainer.style.cursor = 'grab';
                    console.log(`All image loads for set ${setNumber} have settled.`);
                }
            });

        } catch (error) {
            if (error && error.name !== 'AbortError') {
                console.error(`Failed to load image set ${setNumber}:`, error);
                setInfo.textContent = `Set: ${setNumber} (Load Error)`;
                loadingIndicator.style.display = 'none';
                gridContainer.style.cursor = 'default';
            }
        }
    }

    // --- Event Handlers ---
    function changeSet(delta) {
        if (availableSets.length === 0) return;
        const newIndex = (currentSetIndex + delta + availableSets.length) % availableSets.length;
        if (newIndex !== currentSetIndex) {
            currentSetIndex = newIndex;
            loadSet(availableSets[currentSetIndex]);
        }
    }

    // --- FIX ---
    // Corrected function to clamp the viewState's center point.
    function clampViewState() {
        // Use the first image's dimensions as a reference.
        const refDim = imageDimensions.tl;
        if (!refDim || refDim.width <= 0) return;

        const canvasAspect = canvasElements.tl.width / canvasElements.tl.height;
        let zoom = viewState.zoom;

        // Replicate the logic from drawView to calculate the final source view dimensions.
        let sh = refDim.height * zoom;
        let sw = sh * canvasAspect;

        if (sw > refDim.width) {
            sw = refDim.width;
            sh = sw / canvasAspect;
        }
        if (sh > refDim.height) {
            sh = refDim.height;
            sw = sh * canvasAspect;
        }

        // Calculate the viewport size in normalized image coordinates.
        const viewWidthNorm = sw / refDim.width;
        const viewHeightNorm = sh / refDim.height;

        // The center point cannot be closer to an edge than half the viewport size.
        const minX = viewWidthNorm / 2;
        const maxX = 1.0 - viewWidthNorm / 2;
        const minY = viewHeightNorm / 2;
        const maxY = 1.0 - viewHeightNorm / 2;

        // If min > max, the view is larger than the image, so center it.
        viewState.centerX = clamp(viewState.centerX, Math.min(minX, maxX), Math.max(minX, maxX));
        viewState.centerY = clamp(viewState.centerY, Math.min(minY, maxY), Math.max(minY, maxY));
    }


    function handleZoom(factor, mouseClientX = null, mouseClientY = null) {
        const oldZoom = viewState.zoom;
        const newZoom = clamp(viewState.zoom / factor, MIN_NORMALIZED_HEIGHT, MAX_NORMALIZED_HEIGHT);

        if (Math.abs(newZoom - oldZoom) < 1e-6) return;

        const refDim = imageDimensions.tl;
        if (!refDim) return; // Can't zoom without a reference image

        let zoomTargetXNorm = viewState.centerX;
        let zoomTargetYNorm = viewState.centerY;

        const canvasAspect = canvasElements.tl.width / canvasElements.tl.height;
        const imageAspect = refDim.width / refDim.height;

        if (mouseClientX !== null && mouseClientY !== null) {
            const rect = gridContainer.getBoundingClientRect();

            let oldViewHeightNorm = oldZoom;
            let oldViewWidthNorm = oldViewHeightNorm * canvasAspect * (refDim.height / refDim.width);

            const oldViewXNorm = viewState.centerX - oldViewWidthNorm / 2;
            const oldViewYNorm = viewState.centerY - oldViewHeightNorm / 2;

            const mouseNormXInViewport = (mouseClientX - rect.left) / rect.width;
            const mouseNormYInViewport = (mouseClientY - rect.top) / rect.height;

            zoomTargetXNorm = oldViewXNorm + mouseNormXInViewport * oldViewWidthNorm;
            zoomTargetYNorm = oldViewYNorm + mouseNormYInViewport * oldViewHeightNorm;
        }

        viewState.centerX = zoomTargetXNorm - (zoomTargetXNorm - viewState.centerX) * (oldZoom / newZoom);
        viewState.centerY = zoomTargetYNorm - (zoomTargetYNorm - viewState.centerY) * (oldZoom / newZoom);
        viewState.zoom = newZoom;

        clampViewState();
        throttledDrawView();
    }

    gridContainer.addEventListener('mousedown', (e) => {
        isDragging = true;
        dragStart = { x: e.clientX, y: e.clientY };
        dragStartViewCenter = { x: viewState.centerX, y: viewState.centerY };
        gridContainer.classList.add('dragging');
        e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;

        const refDim = imageDimensions.tl;
        if (!refDim) return;

        const deltaX = e.clientX - dragStart.x;
        const deltaY = e.clientY - dragStart.y;

        const rect = gridContainer.getBoundingClientRect();

        // --- FIX ---
        // Replicate logic from drawView to get the correct view dimensions for drag calculation
        const canvasAspect = rect.width / rect.height;
        let sh = refDim.height * viewState.zoom;
        let sw = sh * canvasAspect;

        if (sw > refDim.width) {
            sw = refDim.width;
            sh = sw / canvasAspect;
        }
        if (sh > refDim.height) {
            sh = refDim.height;
            sw = sh * canvasAspect;
        }

        const viewWidthNorm = sw / refDim.width;
        const viewHeightNorm = sh / refDim.height;

        const deltaNormX = (deltaX / rect.width) * viewWidthNorm;
        const deltaNormY = (deltaY / rect.height) * viewHeightNorm;

        viewState.centerX = dragStartViewCenter.x - deltaNormX;
        viewState.centerY = dragStartViewCenter.y - deltaNormY;

        clampViewState(); // Clamp the view state *after* calculating the new center.

        throttledDrawView();
    });

    document.addEventListener('mouseup', () => {
        isDragging = false;
        gridContainer.classList.remove('dragging');
    });

    gridContainer.addEventListener('wheel', (e) => {
        e.preventDefault();
        const zoomFactor = e.deltaY < 0 ? 1 / ZOOM_FACTOR_STEP : ZOOM_FACTOR_STEP;
        handleZoom(zoomFactor, e.clientX, e.clientY);
    }, { passive: false });

    prevBtn.addEventListener('click', () => changeSet(-1));
    nextBtn.addEventListener('click', () => changeSet(1));

    document.addEventListener('keydown', (e) => {
        const key = e.key.toLowerCase();
        if (['a', 'd'].includes(key)) e.preventDefault();
        switch (key) {
            case 'a': changeSet(-1); break;
            case 'd': changeSet(1); break;
            case 'q': handleZoom(ZOOM_FACTOR_STEP); break;
            case 'e': handleZoom(1 / ZOOM_FACTOR_STEP); break;
        }
    });

    // --- Initialization ---
    async function initialize() {
        try {
            const response = await fetch('/api/image-sets');
            if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);
            const data = await response.json();
            availableSets = data.sets || [];

            if (availableSets.length > 0) {
                prevBtn.disabled = false;
                nextBtn.disabled = false;
                currentSetIndex = 0;
                loadSet(availableSets[currentSetIndex]);
            } else {
                setInfo.textContent = "Set: No sets found!";
            }
        } catch (error) {
            console.error("Failed to initialize:", error);
            setInfo.textContent = "Set: Error loading list!";
        }
    }

    initialize();
});