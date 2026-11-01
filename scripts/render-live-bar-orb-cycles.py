#!/usr/bin/env python3
"""Render a physically-based Vault reference loop in Blender Cycles.

Run from a Blender 4.x installation on a GPU-capable machine:

  blender -b -P scripts/render-live-bar-orb-cycles.py -- \
    --output-dir raytrace-orb --frames 72 --fps 12 --samples 128 --device GPU

The script writes RGBA PNG frames. Encode them to WebM with the command in
docs/orb-raytrace-handoff.md after the render completes.
"""

import argparse
import math
import os
import sys

import bpy
from mathutils import Vector


def arguments():
    argv = sys.argv
    tail = argv[argv.index("--") + 1:] if "--" in argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", default="raytrace-orb")
    parser.add_argument("--frames", type=int, default=72)
    parser.add_argument("--fps", type=int, default=12)
    parser.add_argument("--samples", type=int, default=128)
    parser.add_argument("--device", choices=("CPU", "GPU"), default="GPU")
    return parser.parse_args(tail)


def set_input(node, names, value):
    for name in names:
        socket = node.inputs.get(name)
        if socket is not None:
            socket.default_value = value
            return


def make_principled(name, base_color, roughness, transmission, ior, emission=None, emission_strength=0.0):
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    bsdf = material.node_tree.nodes.get("Principled BSDF")
    set_input(bsdf, ("Base Color",), (*base_color, 1.0))
    set_input(bsdf, ("Metallic",), 0.0)
    set_input(bsdf, ("Roughness",), roughness)
    set_input(bsdf, ("IOR",), ior)
    set_input(bsdf, ("Transmission Weight", "Transmission"), transmission)
    set_input(bsdf, ("Coat Weight", "Clearcoat"), 0.24)
    set_input(bsdf, ("Coat Roughness", "Clearcoat Roughness"), 0.18)
    if emission is not None:
        set_input(bsdf, ("Emission Color", "Emission"), (*emission, 1.0))
        set_input(bsdf, ("Emission Strength",), emission_strength)
    return material


def octahedron(name, radius, scale, material, parent=None):
    vertices = [
        (0.0, radius, 0.0),
        (radius, 0.0, 0.0),
        (0.0, 0.0, radius),
        (-radius, 0.0, 0.0),
        (0.0, 0.0, -radius),
        (0.0, -radius, 0.0),
    ]
    faces = [
        (0, 1, 2), (0, 2, 3), (0, 3, 4), (0, 4, 1),
        (5, 2, 1), (5, 3, 2), (5, 4, 3), (5, 1, 4),
    ]
    mesh = bpy.data.meshes.new(f"{name}Mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    object_ = bpy.data.objects.new(name, mesh)
    object_.scale = scale
    object_.data.materials.append(material)
    if parent is not None:
        object_.parent = parent
    bpy.context.collection.objects.link(object_)
    return object_


def make_window(material, outer_radius, inner_radius, z):
    vertices = []
    faces = []
    for index in range(4):
        angle = math.pi * 0.5 * index + math.pi * 0.5
        next_angle = math.pi * 0.5 * ((index + 1) % 4) + math.pi * 0.5
        base = len(vertices)
        vertices.extend([
            (math.cos(angle) * outer_radius, math.sin(angle) * outer_radius, z),
            (math.cos(next_angle) * outer_radius, math.sin(next_angle) * outer_radius, z),
            (math.cos(next_angle) * inner_radius, math.sin(next_angle) * inner_radius, z + 0.02),
            (math.cos(angle) * inner_radius, math.sin(angle) * inner_radius, z + 0.02),
        ])
        faces.extend([(base, base + 1, base + 2), (base, base + 2, base + 3)])
    mesh = bpy.data.meshes.new("LightWellMesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    object_ = bpy.data.objects.new("LightWell", mesh)
    object_.data.materials.append(material)
    bpy.context.collection.objects.link(object_)
    return object_


def add_area(name, location, energy, color, size, target):
    data = bpy.data.lights.new(name, type="AREA")
    data.energy = energy
    data.color = color
    data.shape = "DISK"
    data.size = size
    object_ = bpy.data.objects.new(name, data)
    object_.location = location
    object_.rotation_euler = (Vector(target) - object_.location).to_track_quat("-Z", "Y").to_euler()
    bpy.context.collection.objects.link(object_)
    return object_


def add_point(name, location, energy, color):
    data = bpy.data.lights.new(name, type="POINT")
    data.energy = energy
    data.color = color
    data.shadow_soft_size = 0.45
    object_ = bpy.data.objects.new(name, data)
    object_.location = location
    bpy.context.collection.objects.link(object_)
    return object_


def configure_cycles(scene, opts):
    scene.render.engine = "CYCLES"
    scene.cycles.samples = opts.samples
    scene.cycles.use_denoising = True
    scene.cycles.max_bounces = 12
    scene.cycles.transmission_bounces = 10
    scene.cycles.transparent_max_bounces = 12
    if hasattr(scene.cycles, "caustics_reflective"):
        scene.cycles.caustics_reflective = True
    if hasattr(scene.cycles, "caustics_refractive"):
        scene.cycles.caustics_refractive = True
    if opts.device == "GPU":
        preferences = bpy.context.preferences.addons["cycles"].preferences
        selected_backend = None
        for backend in ("OPTIX", "CUDA", "HIP", "ONEAPI"):
            try:
                preferences.compute_device_type = backend
                preferences.get_devices()
                if any(device.type != "CPU" for device in preferences.devices):
                    selected_backend = backend
                    break
            except Exception:
                continue
        if selected_backend is None:
            raise RuntimeError(
                "No supported Cycles GPU was detected. Refusing to render on CPU; "
                "install a current GPU driver and Blender Cycles backend first."
            )
        for device in preferences.devices:
            device.use = device.type != "CPU"
        if not any(device.use and device.type != "CPU" for device in preferences.devices):
            raise RuntimeError(f"Cycles backend {selected_backend} exposed no enabled GPU device")
        scene.cycles.device = "GPU"
    else:
        scene.cycles.device = "CPU"


def animate(object_, frames, rotation_start, rotation_end):
    object_.rotation_euler = tuple(math.radians(value) for value in rotation_start)
    object_.keyframe_insert(data_path="rotation_euler", frame=1)
    object_.rotation_euler = tuple(math.radians(value) for value in rotation_end)
    object_.keyframe_insert(data_path="rotation_euler", frame=frames)
    if object_.animation_data and object_.animation_data.action:
        for curve in object_.animation_data.action.fcurves:
            for keyframe in curve.keyframe_points:
                keyframe.interpolation = "LINEAR"


def main():
    opts = arguments()
    output_dir = os.path.abspath(opts.output_dir)
    os.makedirs(output_dir, exist_ok=True)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for block in (bpy.data.meshes, bpy.data.materials, bpy.data.cameras, bpy.data.lights):
        for item in list(block):
            if item.users == 0:
                block.remove(item)

    scene = bpy.context.scene
    configure_cycles(scene, opts)
    scene.render.resolution_x = 256
    scene.render.resolution_y = 256
    scene.render.resolution_percentage = 100
    scene.render.fps = opts.fps
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.film_transparent = True
    scene.render.filepath = os.path.join(output_dir, "frame_")
    try:
        scene.view_settings.look = "AgX - Medium High Contrast"
    except Exception:
        pass

    world = bpy.data.worlds.new("VaultWorld") if bpy.data.worlds.get("VaultWorld") is None else bpy.data.worlds["VaultWorld"]
    scene.world = world
    world.use_nodes = True
    background = world.node_tree.nodes.get("Background")
    set_input(background, ("Color",), (0.005, 0.012, 0.018, 1.0))
    set_input(background, ("Strength",), 0.08)

    camera_data = bpy.data.cameras.new("Camera")
    camera = bpy.data.objects.new("Camera", camera_data)
    camera.location = (0.0, 0.0, 6.2)
    camera_data.type = "ORTHO"
    camera_data.ortho_scale = 3.35
    scene.camera = camera
    bpy.context.collection.objects.link(camera)

    shell_material = make_principled(
        "ColdBlueCrystal", (0.15, 0.43, 0.54), 0.22, 0.82, 1.46,
        emission=(0.02, 0.12, 0.18), emission_strength=0.06,
    )
    prism_material = make_principled(
        "InternalPrism", (0.06, 0.37, 0.60), 0.10, 0.88, 1.46,
        emission=(0.02, 0.22, 0.44), emission_strength=0.12,
    )
    shard_material = make_principled(
        "InternalShard", (0.03, 0.20, 0.38), 0.14, 0.78, 1.46,
        emission=(0.01, 0.08, 0.20), emission_strength=0.08,
    )
    window_material = make_principled("LightWell", (0.005, 0.025, 0.035), 0.38, 0.0, 1.46)
    core_material = make_principled(
        "ColdWhiteCore", (0.76, 0.95, 1.0), 0.18, 0.25, 1.46,
        emission=(0.30, 0.82, 1.0), emission_strength=2.4,
    )

    root = bpy.data.objects.new("VaultRoot", None)
    bpy.context.collection.objects.link(root)
    shell = octahedron("VaultShell", 1.08, (0.86, 1.08, 0.86), shell_material, root)
    prism = octahedron("InternalPrism", 0.76, (0.82, 1.04, 0.74), prism_material, root)
    prism.rotation_euler = (0.18, -0.34, 0.26)
    shard = octahedron("InternalShard", 0.47, (0.76, 1.16, 0.62), shard_material, root)
    shard.rotation_euler = (-0.42, 0.25, -0.18)
    window = make_window(window_material, 0.44, 0.21, 0.97)
    window.parent = root
    core = octahedron("Core", 0.18, (0.62, 1.16, 0.20), core_material, root)
    core.location.z = 0.91

    add_area("Key", (-3.8, 4.8, 4.8), 380, (0.80, 0.94, 1.0), 3.2, (0.0, 0.0, 0.0))
    add_area("Fill", (4.5, -0.4, 3.0), 190, (0.32, 0.68, 0.82), 3.8, (0.0, 0.0, 0.0))
    add_area("Edge", (-1.4, -2.6, 2.4), 150, (0.45, 0.82, 0.92), 2.8, (0.0, 0.0, 0.0))
    add_point("CoreLight", (0.0, 0.0, 0.88), 80, (0.55, 0.88, 1.0))
    add_point("PrismLightA", (-0.38, 0.34, 0.22), 38, (0.35, 0.80, 1.0))
    add_point("PrismLightB", (0.34, -0.26, 0.16), 28, (0.20, 0.48, 0.85))

    animate(root, opts.frames, (-4.0, -14.0, 2.0), (4.0, 8.0, 7.0))
    animate(prism, opts.frames, (10.0, -20.0, 16.0), (18.0, -8.0, 22.0))
    animate(shard, opts.frames, (-24.0, 14.0, -10.0), (-17.0, 2.0, -16.0))
    scene.frame_start = 1
    scene.frame_end = opts.frames
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(output_dir, "vault-raytrace.blend"))
    bpy.ops.render.render(animation=True)
    print(f"raytrace render complete: {output_dir}")


if __name__ == "__main__":
    main()
