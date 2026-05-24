import os
from PIL import Image

def generate_icons(source_path, dest_dir):
    print(f"Loading source image from: {source_path}")
    img = Image.open(source_path)
    
    # Standard sizes to generate
    sizes = {
        "32x32.png": (32, 32),
        "128x128.png": (128, 128),
        "128x128@2x.png": (256, 256),
        "icon.png": (512, 512),
        "Square30x30Logo.png": (30, 30),
        "Square44x44Logo.png": (44, 44),
        "Square71x71Logo.png": (71, 71),
        "Square89x89Logo.png": (89, 89),
        "Square107x107Logo.png": (107, 107),
        "Square142x142Logo.png": (142, 142),
        "Square150x150Logo.png": (150, 150),
        "Square284x284Logo.png": (284, 284),
        "Square310x310Logo.png": (310, 310),
        "StoreLogo.png": (50, 50)
    }
    
    os.makedirs(dest_dir, exist_ok=True)
    
    # Save PNG files
    for name, size in sizes.items():
        resized = img.resize(size, Image.Resampling.LANCZOS)
        out_path = os.path.join(dest_dir, name)
        resized.save(out_path, "PNG")
        print(f"Saved: {out_path}")
        
    # Save .ico file
    ico_path = os.path.join(dest_dir, "icon.ico")
    ico_sizes = [(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    ico_imgs = [img.resize(size, Image.Resampling.LANCZOS) for size in ico_sizes]
    ico_imgs[0].save(ico_path, format="ICO", sizes=ico_sizes, append_images=ico_imgs[1:])
    print(f"Saved: {ico_path}")
    
    print("Icons generated successfully!")

if __name__ == "__main__":
    source = r"C:\Users\Bruno Leite\.gemini\antigravity\brain\26267f22-16be-41c0-93c8-186f7fa657de\app_icon_1779371069502.png"
    dest = r"c:\Users\Bruno Leite\Desktop\formatura-pro\src-tauri\icons"
    generate_icons(source, dest)
