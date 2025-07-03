import logging
import os
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from contextlib import asynccontextmanager

from . import image_utils
from .image_utils import REFERENCE_DIR, IMAGE_DIR_1, IMAGE_DIR_2, QUADRANT_W, QUADRANT_H

logger = logging.getLogger(__name__)

app_state = {"available_sets": []}

def get_image_urls_for_set(set_number: str, request: Request) -> dict | None:
    """
    Constructs the URLs for the four original images of a set,
    assuming original directories are mounted directly.
    """
    try:
        original_filenames_paths = image_utils.get_filenames(set_number)
        tl_name = os.path.basename(original_filenames_paths["tl"])
        tr_name = os.path.basename(original_filenames_paths["tr"])
        bl_name = os.path.basename(original_filenames_paths["bl"])
        br_name = os.path.basename(original_filenames_paths["br"])

        urls = {
            "tl": str(request.url_for('static_ref', path=tl_name)),
            "tr": str(request.url_for('static_ref', path=tr_name)),
            "bl": str(request.url_for('static_img1', path=bl_name)),
            "br": str(request.url_for('static_img2', path=br_name)),
        }
        return urls
    except Exception as e:
        logger.error(f"Could not construct URLs for set {set_number}: {e}")
        return None

@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Application startup: Finding available image sets...")
    app_state["available_sets"] = image_utils.find_available_image_sets()
    if not app_state["available_sets"]:
        logger.warning("!!! No image sets found during startup !!!")
    else:
        logger.info(f"Found {len(app_state['available_sets'])} image sets.")
    yield
    logger.info("Application shutdown.")

app = FastAPI(lifespan=lifespan)

app.mount("/static", StaticFiles(directory="static"), name="static")

try:
    logger.info(f"Mounting REFERENCE_DIR ({REFERENCE_DIR}) at /static-ref")
    app.mount("/static-ref", StaticFiles(directory=REFERENCE_DIR), name="static_ref")
    logger.info(f"Mounting IMAGE_DIR_1 ({IMAGE_DIR_1}) at /static-img1")
    app.mount("/static-img1", StaticFiles(directory=IMAGE_DIR_1), name="static_img1")
    logger.info(f"Mounting IMAGE_DIR_2 ({IMAGE_DIR_2}) at /static-img2")
    app.mount("/static-img2", StaticFiles(directory=IMAGE_DIR_2), name="static_img2")
except RuntimeError as e:
     logger.error(f"Error mounting static directories: {e}")
     logger.error("Please ensure the directories exist and have correct permissions.")

templates = Jinja2Templates(directory="app/templates")

@app.get("/", response_class=HTMLResponse)
async def read_root(request: Request):
    """Serves the main HTML page."""
    return templates.TemplateResponse(
        "index.html",
        {
            "request": request,
            "quadrant_w": QUADRANT_W,
            "quadrant_h": QUADRANT_H
        }
    )

@app.get("/api/image-sets", response_class=JSONResponse)
async def get_image_sets():
    """Returns the list of available image set numbers."""
    return {"sets": app_state["available_sets"]}

@app.get("/api/image-urls/{set_number}", response_class=JSONResponse)
async def get_image_urls(set_number: str, request: Request):
    """Returns the URLs for the four original images of a set."""
    if set_number not in app_state["available_sets"]:
        raise HTTPException(status_code=404, detail=f"Image set '{set_number}' not found.")
    urls = get_image_urls_for_set(set_number, request)
    if not urls:
         raise HTTPException(status_code=500, detail=f"Could not construct URLs for image set '{set_number}'.")
    return JSONResponse(content=urls)

@app.get("/api/image-preview/{set_number}/{quadrant}",
         response_class=Response,
         responses={
             200: {"content": {"image/jpeg": {}}},
             404: {"description": "Image or set not found"},
             500: {"description": "Error creating preview"}
         })
async def get_image_preview(set_number: str, quadrant: str):
    """
    Generates and returns a low-resolution JPEG preview for a specific image quadrant.
    The underlying full image is loaded from cache and is already normalized.
    """
    if set_number not in app_state["available_sets"]:
        raise HTTPException(status_code=404, detail=f"Image set '{set_number}' not found.")
    if quadrant not in ["tl", "tr", "bl", "br"]:
        raise HTTPException(status_code=404, detail=f"Invalid quadrant '{quadrant}'.")

    # Get the filepath for the requested quadrant
    filenames = image_utils.get_filenames(set_number)
    filepath = filenames.get(quadrant)

    if not filepath or not os.path.exists(filepath):
         raise HTTPException(status_code=404, detail=f"File path not found for {set_number}/{quadrant}.")

    # Load the full-size (and now normalized) image using the cached function
    full_image = image_utils.load_full_image(filepath)
    if full_image is None:
        raise HTTPException(status_code=404, detail=f"Could not load image file for {set_number}/{quadrant}.")

    # Create the low-resolution preview
    preview_bytes = image_utils.create_low_res_preview(full_image)
    if preview_bytes is None:
        raise HTTPException(status_code=500, detail="Failed to generate image preview.")

    # Return the image bytes directly with the correct media type
    return Response(content=preview_bytes, media_type="image/jpeg")
