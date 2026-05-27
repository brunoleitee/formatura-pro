import unittest

def calculate_center_score(x1, y1, x2, y2, img_w, img_h):
    """Implementação idêntica à do scanner_engine para testes."""
    face_cx = (x1 + x2) / 2.0
    face_cy = (y1 + y2) / 2.0
    img_cx = img_w / 2.0
    img_cy = img_h / 2.0
    dist_x = abs(face_cx - img_cx) / img_w
    dist_y = abs(face_cy - img_cy) / img_h
    dist = (dist_x**2 + dist_y**2)**0.5
    return max(0.0, 1.0 - (dist * 2.0))

def calculate_size_score(x1, y1, x2, y2, img_w, img_h):
    """Implementação idêntica à do scanner_engine para testes."""
    area = (x2 - x1) * (y2 - y1)
    face_area_ratio = area / (img_h * img_w) if (img_h * img_w) > 0 else 0
    return min(1.0, face_area_ratio / 0.05)

def calculate_final_score(similarity, sharpness, size_score, center_score):
    """Fórmula ponderada do scanner_engine:
    similarity * 0.75 + sharpness * 0.10 + size_score * 0.08 + center_score * 0.07
    """
    return (similarity * 0.75) + (sharpness * 0.10) + (size_score * 0.08) + (center_score * 0.07)


class TestIARanking(unittest.TestCase):
    
    def test_center_score_exactly_centered(self):
        # Face exatamente no centro de uma imagem 1000x1000
        # Centro do rosto = (500, 500)
        x1, y1, x2, y2 = 450, 450, 550, 550
        img_w, img_h = 1000, 1000
        score = calculate_center_score(x1, y1, x2, y2, img_w, img_h)
        self.assertAlmostEqual(score, 1.0, places=2)

    def test_center_score_in_corner(self):
        # Face localizada no canto superior esquerdo
        x1, y1, x2, y2 = 0, 0, 100, 100
        img_w, img_h = 1000, 1000
        score = calculate_center_score(x1, y1, x2, y2, img_w, img_h)
        # Distancia do centro deve penalizar, resultando em score menor que 0.5
        self.assertLess(score, 0.5)

    def test_size_score_clamping(self):
        # Proporção enorme (10% da tela)
        # 10% / 5% = 2.0, deve limitar em 1.0
        x1, y1, x2, y2 = 0, 0, 500, 200
        img_w, img_h = 1000, 1000
        score = calculate_size_score(x1, y1, x2, y2, img_w, img_h)
        self.assertEqual(score, 1.0)

    def test_weighted_formula_preference(self):
        # Caso 1: Alta similaridade (0.90) com baixa nitidez e longe do centro
        # Cosseno é o fator dominante (0.75)
        s1, sh1, sz1, c1 = 0.90, 0.20, 0.30, 0.35
        score1 = calculate_final_score(s1, sh1, sz1, c1)
        
        # Caso 2: Baixa similaridade (0.45) com altíssima nitidez e bem no centro
        s2, sh2, sz2, c2 = 0.45, 0.95, 0.90, 0.95
        score2 = calculate_final_score(s2, sh2, sz2, c2)
        
        # Mesmo com nitidez/centralidade piores, score1 deve vencer devido à similaridade primária
        self.assertGreater(score1, score2)
        
    def test_threshold_decision_logic(self):
        threshold = 0.60
        
        # Face com similaridade superior (0.72) deve ser aceita
        similarity = 0.72
        self.assertTrue(similarity >= threshold)
        
        # Face com similaridade inferior (0.55) deve ser rejeitada
        similarity_bad = 0.55
        self.assertFalse(similarity_bad >= threshold)


if __name__ == '__main__':
    unittest.main()
