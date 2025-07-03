import cv2
import numpy as np
import os
import glob
import re
import logging
from functools import lru_cache
from dotenv import load_dotenv

# --- Configuration Loading ---
load_dotenv()

REFERENCE_DIR = os.getenv("REFERENCE_DIR", "/mnt/HDD6TB/dataset/HAT/RAW/png/")
IMAGE_DIR_1 = os.getenv("IMAGE_DIR_1", "/mnt/HDD6TB/dataset/HAT/results/HAT_SRx5_x4-x20_FDL/visualization/custom")
IMAGE_DIR_2 = os.getenv("IMAGE_DIR_2", "/mnt/HDD6TB/dataset/HAT/results/HAT_SRx5_x4_RL-x20_FDL/visualization/custom")
QUADRANT_W = int(os.getenv("QUADRANT_W", "1200"))
QUADRANT_H = int(os.getenv("QUADRANT_H", "700"))

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


# --- Image Discovery ---
def get_filenames(number_str: str):
    """Generates the expected FULL PATH filenames for a given number string."""
    return {
        "tl": os.path.join(REFERENCE_DIR, f"{number_str}-4x_cropped.png"),
        "tr": os.path.join(REFERENCE_DIR, f"{number_str}-20x.png"),
        "bl": os.path.join(IMAGE_DIR_1, f"{number_str}-4x_cropped_HAT_RAW_FDL_grayscale_v2_TEST.png"),
        "br": os.path.join(IMAGE_DIR_2, f"{number_str}-4x_cropped_HAT_DUAL_earlyfusion_FDL_grayscale_v2_TEST.png"),
    }


@lru_cache(maxsize=1)
def find_available_image_sets() -> list[str]:
    """
    Finds all available image set numbers by scanning REFERENCE_DIR
    and verifying all four files exist.
    Returns a sorted list of number strings.
    """
    potential_numbers = set()
    pattern = os.path.join(REFERENCE_DIR, "????-4x_cropped.png")
    files = glob.glob(pattern)
    num_pattern = re.compile(r"(\d{4})-4x_cropped\.png$")

    logger.info(f"Scanning for potential sets using pattern: {pattern}")
    for f in files:
        match = num_pattern.search(os.path.basename(f))
        if match:
            potential_numbers.add(match.group(1))

    if not potential_numbers:
        logger.warning(f"No potential image numbers found in '{REFERENCE_DIR}'.")
        return []

    logger.info(f"Found {len(potential_numbers)} potential numbers. Verifying complete sets...")
    complete_sets = [
        num for num in sorted(list(potential_numbers))
        if all(os.path.exists(f) for f in get_filenames(num).values())
    ]

    logger.info(f"Found {len(complete_sets)} complete image sets.")
    if not complete_sets and potential_numbers:
        logger.error("No complete image sets found where all four files exist.")
        example_num = sorted(list(potential_numbers))[0]
        logger.info(f"Example expected paths for set '{example_num}':")
        for key, fpath in get_filenames(example_num).items():
            logger.info(f"  {key}: {fpath} (Exists: {os.path.exists(fpath)})")

    return complete_sets


# --- Image Processing and Caching ---

def normalize_image(img: np.ndarray) -> np.ndarray | None:
    """
    Normalizes the image by applying Contrast Limited Adaptive Histogram Equalization (CLAHE).
    This enhances local contrast. It works by converting the image to LAB color space
    and applying CLAHE only to the L (lightness) channel, avoiding color distortion.
    """
    if img is None:
        return None
    try:
        if len(img.shape) < 3 or img.shape[2] == 1:  # Grayscale image
            clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
            final_img = clahe.apply(img)
            logger.debug("Grayscale image normalized using CLAHE.")
        else:  # Color image
            lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB)
            l, a, b = cv2.split(lab)
            clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
            cl = clahe.apply(l)
            limg = cv2.merge((cl, a, b))
            final_img = cv2.cvtColor(limg, cv2.COLOR_LAB2BGR)
            logger.debug("Color image normalized using CLAHE.")
        return final_img
    except cv2.error as e:
        logger.error(f"OpenCV error during normalization: {e}")
        return img  # Return original image on failure


@lru_cache(maxsize=32)  # Cache for full-size, processed images
def load_full_image(filepath: str) -> np.ndarray | None:
    """
    Loads a single image from disk, normalizes it, and caches the result.
    Returns None if the file cannot be loaded.
    """
    try:
        if not os.path.exists(filepath):
            logger.error(f"File not found on load attempt: {filepath}")
            return None
        img = cv2.imread(filepath, cv2.IMREAD_UNCHANGED)
        if img is None:
            logger.error(f"Failed to load image (cv2.imread returned None): {filepath}")
            return None
        logger.debug(f"Loaded image: {filepath} ({img.shape})")

        # --- Normalize the image after loading ---
        return normalize_image(img)
    except Exception as e:
        logger.error(f"Exception loading image {filepath}: {e}")
        return None


def create_low_res_preview(img: np.ndarray, width: int = 400) -> bytes | None:
    """
    Creates a low-resolution JPEG preview of an image for fast client-side loading.
    Downscales the image and encodes it as a JPEG byte buffer.
    """
    if img is None:
        return None
    try:
        h, w = img.shape[:2]
        if w == 0: return None
        scale = width / w
        new_h = int(h * scale)
        new_w = width

        resized = cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_AREA)

        success, buffer = cv2.imencode('.jpg', resized, [int(cv2.IMWRITE_JPEG_QUALITY), 80])
        if not success:
            logger.error("Failed to encode low-res preview to JPEG.")
            return None

        return buffer.tobytes()
    except Exception as e:
        logger.error(f"Exception creating low-res preview: {e}")
        return None
