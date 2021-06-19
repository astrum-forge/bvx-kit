/**
 * Generic Key interface that provides access to x,y,z coordinates
 */
export interface Key {
    get x(): number;
    set x(value: number);

    get y(): number;
    set y(value: number);

    get z(): number;
    set z(value: number);

    get key(): number;

    cmp(other: Key): boolean;
}