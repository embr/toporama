"""Dump Python reference outputs for a set of synthetic builds so the JS
port can be validated against them. Writes web/reference.json."""
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from toporama import build, geometry, mercator  # noqa: E402


def synth_world_grid(north, south, west, east, max_points, seed=0):
    """Build the mercator grid and attach a deterministic synthetic
    elevation (mix of sinusoids) so Python and JS start from identical
    world-meter points."""
    pts_lng_lat, m, n = build.build_lng_lat_grid(
        north, south, west, east, max_points)
    xs = pts_lng_lat[:, 0]
    ys = pts_lng_lat[:, 1]
    rx = np.ptp(xs) or 1.0
    ry = np.ptp(ys) or 1.0
    cx, cy = xs.mean(), ys.mean()
    e = (900 * np.sin((xs - cx) / rx * 7)
         + 500 * np.cos((ys - cy) / ry * 5)
         + 300 * np.sin((xs - cx) / rx * 17) * np.cos((ys - cy) / ry * 13))
    e = np.maximum(e - e.min(), 0.0)
    pts_2d = build.project_pts(pts_lng_lat)
    world = np.hstack((pts_2d, e.reshape(-1, 1)))
    return world, m, n


def build_solid(model, world, m, n):
    if model.get('distortion_exponent') is not None:
        # mutates world in place
        build.power_function_distort(
            world, model['distortion_exponent'],
            model.get('distortion_normalization_min'),
            model.get('distortion_normalization_max'))
    # rescale_pts returns a NEW array (does not mutate) -- must capture it
    world, _, _, _ = build.rescale_pts(
        world, model['output_x_meters'],
        output_z_meters=model.get('output_z_meters'),
        z_distortion=model.get('output_z_distortion'))
    top = build.make_top(world, m, n, model['top_pad_width'])
    bottom = build.make_bottom(top, model['top_thickness'],
                               model['wall_thickness'], model['min_z_val'])
    sides = build.make_sides(top, bottom)
    solid = build.union_meshes([top, bottom, sides])
    return solid


def summarize_mesh(solid):
    """Order-independent geometry signatures that Python and JS both
    compute identically (float sums are commutative up to rounding, so we
    round generously and compare with tolerance)."""
    v = solid.vertices
    tri = v[solid.faces]
    centroids = tri.mean(axis=1)
    areas = 0.5 * np.linalg.norm(
        np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0]), axis=1)
    return {
        'num_vertices': int(len(v)),
        'num_faces': int(len(solid.faces)),
        'watertight': bool(geometry.is_watertight(solid)),
        'winding_consistent': bool(geometry.is_winding_consistent(solid)),
        'bbox_min': [round(float(x), 6) for x in v.min(axis=0)],
        'bbox_max': [round(float(x), 6) for x in v.max(axis=0)],
        'total_area': round(float(areas.sum()), 4),
        'sum_xyz': [round(float(s), 4) for s in v.sum(axis=0)],
        'sumsq': round(float((v * v).sum()), 3),
        'centroid_sum': [round(float(s), 4) for s in centroids.sum(axis=0)],
    }


CASES = [
    {'name': 'plain_distortion',
     'bbox': (38.0, 37.5, -120.0, -119.3), 'max_points': 40,
     'model': {'output_x_meters': 0.2, 'output_z_distortion': 2.0,
               'top_thickness': 0.0007, 'top_pad_width': 0.0007,
               'wall_thickness': 0.001, 'min_z_val': None}},
    {'name': 'thickness_constraint',
     'bbox': (46.95, 46.75, -121.95, -121.6), 'max_points': 55,
     'model': {'output_x_meters': 0.18, 'output_z_meters': 0.025,
               'top_thickness': 0.0007, 'top_pad_width': 0.0007,
               'wall_thickness': 0.001, 'min_z_val': None}},
    {'name': 'sturdy_exponent',
     'bbox': (38.0, 37.5, -120.0, -119.3), 'max_points': 48,
     'model': {'output_x_meters': 0.2, 'output_z_distortion': 3.0,
               'distortion_exponent': 0.5,
               'top_thickness': 0.003, 'top_pad_width': 0.003,
               'wall_thickness': 0.004, 'min_z_val': None}},
    {'name': 'min_z_val',
     'bbox': (38.0, 37.5, -120.0, -119.3), 'max_points': 44,
     'model': {'output_x_meters': 0.2, 'output_z_distortion': 2.0,
               'top_thickness': 0.001, 'top_pad_width': 0.001,
               'wall_thickness': 0.0015, 'min_z_val': -0.002}},
]


def main():
    out = {}
    for case in CASES:
        n0, s0, w0, e0 = case['bbox']
        world, m, n = synth_world_grid(n0, s0, w0, e0, case['max_points'])
        # save the pre-distortion world grid so JS starts identically
        world_input = world.copy()
        solid = build_solid(case['model'], world, m, n)
        out[case['name']] = {
            'model': case['model'],
            'm': int(m), 'n': int(n),
            'world': world_input.reshape(-1).tolist(),
            'summary': summarize_mesh(solid),
        }
    path = os.path.join(os.path.dirname(__file__), 'reference.json')
    with open(path, 'w') as fout:
        json.dump(out, fout)
    print('wrote', path, 'with cases:', list(out.keys()))


if __name__ == '__main__':
    main()
